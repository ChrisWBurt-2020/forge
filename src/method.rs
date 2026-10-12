//! The locations of a method's parameters, and its body and responses.

use std::fmt;

use crate::arena::Str;
use crate::types::TypeId;
use crate::{Forge, Type};

/// Where a parameter of a [`Method`](crate::Method) is sent, as
/// [`Method::location`](crate::Method::location) gives it.
///
/// Corresponds to `in` in the
/// [Parameter Object](https://spec.openapis.org/oas/latest.html#parameter-object).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Location {
    /// In the path, in place of `{name}` in the path template, where
    /// `name` is the field's wire name.
    ///
    /// Only the default style, `simple`, is covered. The `label` and
    /// `matrix` styles are errors.
    Path,
    /// In the query string.
    ///
    /// Only the default style, `form`, is covered. The `spaceDelimited`,
    /// `pipeDelimited` and `deepObject` styles are errors.
    Query {
        /// Whether each item of an array is sent as its own parameter, as
        /// in `ids=1&ids=2`, rather than joined with commas, as in
        /// `ids=1,2`, and likewise each property of an object.
        ///
        /// Corresponds to `explode` in the parameter, which is true by
        /// default.
        exploded: bool,
    },
}

/// The request body of a [`Method`](crate::Method).
///
/// Corresponds to a
/// [Request Body Object](https://spec.openapis.org/oas/latest.html#request-body-object).
#[derive(Clone, Copy)]
pub struct Body<'f> {
    forge: &'f Forge,
    data: &'f BodyData,
}

/// A response that a [`Method`](crate::Method) declares.
///
/// Corresponds to a
/// [Response Object](https://spec.openapis.org/oas/latest.html#response-object).
#[derive(Clone, Copy)]
pub struct Response<'f> {
    forge: &'f Forge,
    data: &'f ResponseData,
}

/// The type of a [`Body`] or [`Response`] in one media type.
///
/// Corresponds to an entry of `content`, a
/// [Media Type Object](https://spec.openapis.org/oas/latest.html#media-type-object).
#[derive(Clone, Copy)]
pub struct Content<'f> {
    forge: &'f Forge,
    data: &'f ContentData,
}

impl<'f> Body<'f> {
    /// Reports whether a request must have the body.
    pub fn is_required(self) -> bool {
        self.data.required
    }

    /// Returns a description of the body, or an empty string if it has
    /// none.
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data.description)
    }

    /// Returns each media type the body can be sent as, sorted by media
    /// type.
    pub fn contents(self) -> impl ExactSizeIterator<Item = Content<'f>> {
        contents(self.forge, &self.data.contents)
    }

    /// Returns the JSON content a client sends, or `None` if the body has
    /// no JSON media type. See [`Content::is_json`].
    ///
    /// It is the content of `application/json`, or else of the first JSON
    /// media type in [`contents`](Body::contents).
    pub fn json(self) -> Option<Content<'f>> {
        json(self.forge, &self.data.contents, self.data.json)
    }
}

impl<'f> Response<'f> {
    /// Returns the status the response is for: a code such as `200`, a
    /// range such as `4XX`, or `default`.
    pub fn status(self) -> &'f str {
        self.forge.strings.get(self.data.status)
    }

    /// Returns a description of the response, or an empty string if it has
    /// none.
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data.description)
    }

    /// Returns each media type of the response's body, sorted by media
    /// type. A response with no body has none.
    pub fn contents(self) -> impl ExactSizeIterator<Item = Content<'f>> {
        contents(self.forge, &self.data.contents)
    }

    /// Returns the content of the response's JSON body, or `None` if the
    /// response has no JSON media type, chosen as for [`Body::json`].
    pub fn json(self) -> Option<Content<'f>> {
        json(self.forge, &self.data.contents, self.data.json)
    }
}

impl<'f> Content<'f> {
    /// Returns the media type, such as `application/json`, as the document
    /// writes it.
    pub fn media_type(self) -> &'f str {
        self.forge.strings.get(self.data.media_type)
    }

    /// Returns a description of the content's schema, or an empty string
    /// if it has none.
    ///
    /// As for a [`Field::description`](crate::Field::description), it is
    /// the schema's own `description`, or else that of the schema its
    /// `$ref` points to, following `$ref`s through any chain of them, or
    /// from OpenAPI 3.1, that of its first `allOf` member with one; never
    /// the `title`. The [`Body::description`] or
    /// [`Response::description`] describes the body or response as a
    /// whole, and this the value in one media type.
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data.description)
    }

    /// Reports whether the media type is JSON: `application/json` or a
    /// type ending in `+json`, ignoring case and parameters.
    pub fn is_json(self) -> bool {
        is_json(self.media_type())
    }

    /// Returns the type of the body in this media type: the type of its
    /// schema, read the same way whether the media type is JSON or not. So
    /// an object schema of `multipart/form-data` is an object with a field
    /// for each part, and a string schema with format `binary` of
    /// `application/octet-stream` is
    /// [`Scalar::Binary`](crate::Scalar::Binary).
    ///
    /// A media type with no schema allows any value, and is
    /// [`Scalar::Unknown`](crate::Scalar::Unknown).
    pub fn ty(self) -> Type<'f> {
        Type::new(self.forge, self.data.ty)
    }
}

fn contents<'f>(forge: &'f Forge, contents: &'f [ContentData]) -> impl ExactSizeIterator<Item = Content<'f>> {
    contents.iter().map(move |data| Content { forge, data })
}

fn json<'f>(forge: &'f Forge, contents: &'f [ContentData], json: Option<u32>) -> Option<Content<'f>> {
    let data = &contents[json? as usize];
    Some(Content { forge, data })
}

/// Reports whether `media_type` is `application/json` or ends in `+json`,
/// ignoring case and parameters.
pub(crate) fn is_json(media_type: &str) -> bool {
    let base = media_type.split(';').next().unwrap_or_default().trim();
    let base = base.to_ascii_lowercase();
    base == "application/json" || base.ends_with("+json")
}

/// What a [`Forge`] stores for a request body.
pub(crate) struct BodyData {
    pub(crate) required: bool,
    pub(crate) description: Str,
    /// Sorted by media type.
    pub(crate) contents: Vec<ContentData>,
    /// The index in `contents` of the JSON content a client sends.
    pub(crate) json: Option<u32>,
}

pub(crate) struct ResponseData {
    pub(crate) status: Str,
    pub(crate) description: Str,
    /// Sorted by media type.
    pub(crate) contents: Vec<ContentData>,
    /// The index in `contents` of the JSON content.
    pub(crate) json: Option<u32>,
}

pub(crate) struct ContentData {
    pub(crate) media_type: Str,
    pub(crate) ty: TypeId,
    pub(crate) description: Str,
}

impl<'f> Body<'f> {
    pub(crate) fn new(forge: &'f Forge, data: &'f BodyData) -> Body<'f> {
        Body { forge, data }
    }
}

impl<'f> Response<'f> {
    pub(crate) fn new(forge: &'f Forge, data: &'f ResponseData) -> Response<'f> {
        Response { forge, data }
    }
}

impl fmt::Debug for Body<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Body")
            .field("required", &self.is_required())
            .field("contents", &self.contents().collect::<Vec<_>>())
            .finish()
    }
}

impl fmt::Debug for Response<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Response")
            .field("status", &self.status())
            .field("contents", &self.contents().collect::<Vec<_>>())
            .finish()
    }
}

impl fmt::Debug for Content<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Content")
            .field("media_type", &self.media_type())
            .field("ty", &self.ty())
            .finish()
    }
}

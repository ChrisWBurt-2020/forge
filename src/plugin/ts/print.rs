use std::fmt::{self, Display};

use super::Ident;

/// A part of a line of TypeScript: text, an [`Ident`], or a sequence of
/// them.
///
/// By default, [`print`](Print::print) appends the text that [`Display`]
/// writes, so a `Display` type only needs an empty impl:
///
/// ```
/// use std::fmt;
/// use forge::ts::Print;
///
/// struct Version(u32);
///
/// impl fmt::Display for Version {
///     fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
///         write!(f, "v{}", self.0)
///     }
/// }
///
/// impl Print for Version {}
/// ```
pub trait Print: Display {
    /// Appends `self` to `out`.
    fn print(&self, out: &mut Fragment) {
        out.text(&self.to_string());
    }
}

/// A sequence of text and identifiers to print as part of a line. A file
/// imports the identifiers when it prints the fragment.
///
/// Build one with [`frag!`](super::frag), [`join()`] or
/// [`push`](Fragment::push) when you need part of a line before printing
/// it.
#[derive(Clone, Debug, Default)]
pub struct Fragment {
    elements: Vec<Element>,
}

/// An element of a [`Fragment`]. Adjacent text is always joined into one
/// element, and empty text is never kept.
#[derive(Clone, Debug)]
pub(super) enum Element {
    Text(String),
    Ident(Ident),
}

impl Fragment {
    /// Returns an empty fragment.
    pub fn new() -> Fragment {
        Fragment::default()
    }

    /// Returns `parts` printed in order, as [`frag!`](super::frag) does.
    pub fn of(parts: &[&dyn Print]) -> Fragment {
        let mut out = Fragment::new();
        for part in parts {
            part.print(&mut out);
        }
        out
    }

    /// Appends `part`.
    pub fn push(&mut self, part: impl Print) -> &mut Fragment {
        part.print(self);
        self
    }

    /// Appends text.
    pub fn text(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        match self.elements.last_mut() {
            Some(Element::Text(last)) => last.push_str(s),
            _ => self.elements.push(Element::Text(s.to_owned())),
        }
    }

    /// Appends an identifier.
    pub fn ident(&mut self, id: Ident) {
        self.elements.push(Element::Ident(id));
    }

    /// Reports whether nothing has been appended, other than empty text.
    pub fn is_empty(&self) -> bool {
        self.elements.is_empty()
    }

    /// Appends the elements of `other`, joining text.
    pub(super) fn append(&mut self, other: Fragment) {
        let mut elements = other.elements.into_iter();
        if let Some(first) = elements.next() {
            match first {
                Element::Text(text) => self.text(&text),
                ident => self.elements.push(ident),
            }
        }
        self.elements.extend(elements);
    }

    pub(super) fn elements(&self) -> &[Element] {
        &self.elements
    }
}

/// Writes the text and each identifier's name unchanged, without the
/// aliases a file might use.
impl Display for Fragment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for element in &self.elements {
            match element {
                Element::Text(text) => f.write_str(text)?,
                Element::Ident(id) => id.fmt(f)?,
            }
        }
        Ok(())
    }
}

impl Print for Fragment {
    fn print(&self, out: &mut Fragment) {
        for element in &self.elements {
            match element {
                Element::Text(text) => out.text(text),
                Element::Ident(id) => out.ident(id.clone()),
            }
        }
    }
}

/// Returns `parts` with `sep` between each two of them, leaving out the
/// parts that print nothing. [`join!`](super::join!) does the same for
/// parts of different types.
///
/// ```
/// # use forge::ts::{self, join, p};
/// let names = ["a", "", "c"];
/// let mut f = ts::File::new(ts::Module::new("x.ts"));
/// p!(f, "const all = [", join(", ", names), "];"); // const all = [a, c];
/// ```
pub fn join<T: Print>(sep: &str, parts: impl IntoIterator<Item = T>) -> Fragment {
    let mut out = Fragment::new();
    for part in parts {
        let part = Fragment::of(&[&part]);
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.text(sep);
        }
        out.append(part);
    }
    out
}

impl Print for str {
    fn print(&self, out: &mut Fragment) {
        out.text(self);
    }
}

impl Print for String {
    fn print(&self, out: &mut Fragment) {
        out.text(self);
    }
}

impl<T: Print + ?Sized> Print for &T {
    fn print(&self, out: &mut Fragment) {
        (**self).print(out);
    }
}

macro_rules! print_display {
    ($($ty:ty),*) => {$(
        impl Print for $ty {}
    )*};
}

print_display!(
    char, bool, i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize, f32, f64
);

#[doc(hidden)]
#[macro_export]
macro_rules! __ts_join {
    ($sep:expr $(,)?) => {
        $crate::ts::Fragment::new()
    };
    ($sep:expr $(, $part:expr)+ $(,)?) => {
        $crate::ts::join($sep, [$(&$part as &dyn $crate::ts::Print),+])
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __ts_frag {
    ($($part:expr),* $(,)?) => {
        $crate::ts::Fragment::of(&[$(&$part as &dyn $crate::ts::Print),*])
    };
}

//! `forge::Json`, as src/json.rs has it, read from the JSON text the host
//! sends for a value.

/// A JSON value. See `forge::Json`.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Reads `text`, which the host writes, so it is always JSON.
    pub(crate) fn parse(text: &str) -> Json {
        let value: serde_json::Value = serde_json::from_str(text).expect("the host sends JSON");
        Json::from(value)
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match *self {
            Json::Bool(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            Json::Number(n) => Some(n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(elements) => Some(elements),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(members) => Some(members),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_object()?.iter().find(|(k, _)| k == key).map(|(_, value)| value)
    }
}

impl From<serde_json::Value> for Json {
    fn from(value: serde_json::Value) -> Json {
        match value {
            serde_json::Value::Null => Json::Null,
            serde_json::Value::Bool(b) => Json::Bool(b),
            serde_json::Value::Number(n) => Json::Number(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Json::String(s),
            serde_json::Value::Array(elements) => Json::Array(elements.into_iter().map(Json::from).collect()),
            // `preserve_order` keeps the members in the order written.
            serde_json::Value::Object(members) => {
                Json::Object(members.into_iter().map(|(k, v)| (k, Json::from(v))).collect())
            }
        }
    }
}

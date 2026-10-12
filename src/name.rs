//! Names that a generator spells in the casing of its language.

/// A name from the description, normalized into lower-case words so that a
/// generator can spell it in any casing. Words are split at `-`, `_`, every
/// other character that is not a letter or digit, and case changes:
/// `XMLDocument` is "xml document", `getByID` is "get by id", and
/// `ipv4_cidr` is "ipv4 cidr". Digits belong to the word before them.
///
/// Every word is lower case, so a name has exactly one spelling in each
/// casing, whatever its casing in the description: `GraphQL` is `graphQl`
/// in camelCase.
///
/// A name is only its words. Names written differently but with the same
/// words, such as `get_by_id` and `getByID`, are equal, since every casing
/// spells them the same. Names order by their words.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Name {
    words: Vec<String>,
}

impl Name {
    /// Returns the name written as `s`.
    pub fn new(s: &str) -> Name {
        let mut words = Vec::new();
        // Where the word being read starts in `s`, and its last character.
        let mut word: Option<(usize, char)> = None;
        let mut chars = s.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if !c.is_alphabetic() && !c.is_numeric() {
                flush(&mut words, s, &mut word, i);
                continue;
            }
            if c.is_uppercase()
                && let Some((_, prev)) = word
            {
                // A lower-case letter or digit ends a word before an
                // upper-case one ("getBy" and "ipv4Cidr"), and so does the
                // last letter of an acronym before a new word
                // ("XMLDocument").
                let next_lower = chars.peek().is_some_and(|&(_, next)| next.is_lowercase());
                if prev.is_lowercase() || prev.is_numeric() || (prev.is_uppercase() && next_lower) {
                    flush(&mut words, s, &mut word, i);
                }
            }
            let start = match word {
                Some((start, _)) => start,
                None => i,
            };
            word = Some((start, c));
        }
        flush(&mut words, s, &mut word, s.len());
        Name { words }
    }

    /// Returns the lower-case words of the name.
    pub fn words(&self) -> &[String] {
        &self.words
    }

    /// Reports whether the name has no words: what was written has no
    /// letters or digits, such as `-`.
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// Returns the name in camelCase: `petStore`.
    pub fn camel(&self) -> String {
        let mut out = String::with_capacity(self.words_len());
        for (i, word) in self.words.iter().enumerate() {
            if i == 0 {
                out.push_str(word);
            } else {
                push_upper_first(&mut out, word);
            }
        }
        out
    }

    /// Returns the name in PascalCase: `PetStore`.
    pub fn pascal(&self) -> String {
        let mut out = String::with_capacity(self.words_len());
        for word in &self.words {
            push_upper_first(&mut out, word);
        }
        out
    }

    /// Returns the name in snake_case: `pet_store`.
    pub fn snake(&self) -> String {
        self.words.join("_")
    }

    /// Returns the name in kebab-case: `pet-store`.
    pub fn kebab(&self) -> String {
        self.words.join("-")
    }

    /// Returns the length in bytes of the words without separators: the
    /// exact length of the camelCase and PascalCase spellings, unless
    /// upper-casing a letter changes its length, as `ŉ` to `ʼN` does.
    fn words_len(&self) -> usize {
        self.words.iter().map(String::len).sum()
    }
}

/// Ends the word being read, if there is one, at byte `end` of `s`, and
/// adds it to `words` in lower case.
fn flush(words: &mut Vec<String>, s: &str, word: &mut Option<(usize, char)>, end: usize) {
    if let Some((start, _)) = word.take() {
        words.push(s[start..end].to_lowercase());
    }
}

fn push_upper_first(out: &mut String, word: &str) {
    let mut chars = word.chars();
    if let Some(first) = chars.next() {
        out.extend(first.to_uppercase());
        out.push_str(chars.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn casings() {
        for (written, camel, pascal, snake, kebab) in [
            ("pet-store", "petStore", "PetStore", "pet_store", "pet-store"),
            ("created_at", "createdAt", "CreatedAt", "created_at", "created-at"),
            (
                "XMLDocument",
                "xmlDocument",
                "XmlDocument",
                "xml_document",
                "xml-document",
            ),
            ("GraphQL", "graphQl", "GraphQl", "graph_ql", "graph-ql"),
            ("ipv4_cidr", "ipv4Cidr", "Ipv4Cidr", "ipv4_cidr", "ipv4-cidr"),
            ("getByID", "getById", "GetById", "get_by_id", "get-by-id"),
            ("name.eq", "nameEq", "NameEq", "name_eq", "name-eq"),
            ("2fa", "2fa", "2fa", "2fa", "2fa"),
            ("__x__", "x", "X", "x", "x"),
        ] {
            let name = Name::new(written);
            assert_eq!(
                [name.camel(), name.pascal(), name.snake(), name.kebab()],
                [camel, pascal, snake, kebab],
                "casings of {written:?}"
            );
        }
    }

    #[test]
    fn words() {
        assert_eq!(Name::new("XMLDocument").words(), ["xml", "document"]);
        assert_eq!(Name::new("getByID").words(), ["get", "by", "id"]);
    }

    #[test]
    fn equal_when_the_words_are() {
        for (a, b) in [
            ("get_by_id", "getByID"),
            ("get-by-id", "GetById"),
            ("pet.store", "PET_STORE"),
            ("__x__", "x"),
        ] {
            assert_eq!(Name::new(a), Name::new(b), "{a:?} and {b:?}");
        }
        assert_ne!(Name::new("ipv4"), Name::new("ip_v4"));
        assert_ne!(Name::new("getby"), Name::new("getBy"));
    }

    #[test]
    fn ordered_by_words() {
        let mut names = ["pet_store", "Pet", "apiKey", "API"].map(Name::new);
        names.sort();
        assert_eq!(names.map(|n| n.snake()), ["api", "api_key", "pet", "pet_store"]);
    }

    #[test]
    fn empty() {
        assert!(Name::new("").is_empty());
        assert!(Name::new("-").is_empty());
        assert_eq!(Name::new("-"), Name::new(""));
        assert_eq!(Name::default(), Name::new(""));
        assert!(!Name::new("x").is_empty());
    }
}

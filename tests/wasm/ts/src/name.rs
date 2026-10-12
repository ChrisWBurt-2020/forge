//! `forge::Name`, as src/name.rs has it, made from the words the host
//! sends rather than parsed.

/// A name from the description, as lower-case words, which a generator
/// spells in the casing of its language. See `forge::Name`.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Name {
    words: Vec<String>,
}

impl Name {
    /// Returns the name with `words`, which the host gives in lower case.
    pub(crate) fn from_words(words: Vec<String>) -> Name {
        Name { words }
    }

    /// Returns the lower-case words of the name.
    pub fn words(&self) -> &[String] {
        &self.words
    }

    /// Reports whether the name has no words.
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

    fn words_len(&self) -> usize {
        self.words.iter().map(String::len).sum()
    }
}

fn push_upper_first(out: &mut String, word: &str) {
    let mut chars = word.chars();
    if let Some(first) = chars.next() {
        out.extend(first.to_uppercase());
        out.push_str(chars.as_str());
    }
}

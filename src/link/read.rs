//! Ways of reading values with serde that know nothing of OpenAPI, for the
//! objects in [`openapi`](super::openapi).

use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{Deserializer, IgnoredAny, SeqAccess, Visitor};

/// Declares `$name`, an enum of the keys of an object that are read,
/// each with the string it is written as, and `Other` for any other key.
/// It is read as an identifier, without allocating.
macro_rules! keys {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $key:literal,)* }) => {
        $(#[$meta])*
        #[derive(Clone, Copy)]
        enum $name {
            $($variant,)*
            Other,
        }

        impl $name {
            /// Returns the key written as `key`.
            fn from_key(key: &str) -> $name {
                match key {
                    $($key => $name::$variant,)*
                    _ => $name::Other,
                }
            }

            /// Returns an error if the key is in `seen`, which has a bit
            /// for each key read so far, and else adds it. Other keys can
            /// be repeated.
            fn once<E: serde::de::Error>(self, seen: &mut u64) -> Result<(), E> {
                let name = match self {
                    $($name::$variant => $key,)*
                    $name::Other => return Ok(()),
                };
                let bit = 1u64 << (self as u32);
                if *seen & bit != 0 {
                    return Err(E::duplicate_field(name));
                }
                *seen |= bit;
                Ok(())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<$name, D::Error> {
                struct KeyVisitor;

                impl serde::de::Visitor<'_> for KeyVisitor {
                    type Value = $name;

                    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        f.write_str("a key")
                    }

                    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<$name, E> {
                        Ok($name::from_key(v))
                    }
                }

                deserializer.deserialize_identifier(KeyVisitor)
            }
        }
    };
}

pub(super) use keys;

/// Reads the first element of a sequence, or the default if it is empty.
/// The rest are skipped.
pub(super) fn first<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    struct First<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de> + Default> Visitor<'de> for First<T> {
        type Value = T;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a sequence")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<T, A::Error> {
            let first = seq.next_element()?;
            while let Some(IgnoredAny) = seq.next_element()? {}
            Ok(first.unwrap_or_default())
        }
    }

    deserializer.deserialize_seq(First(PhantomData))
}

#[cfg(test)]
mod tests {
    use serde::de;
    use serde_json::de::StrRead;

    use super::*;

    /// Reads `json` with `read`, which must succeed.
    #[track_caller]
    fn read<'a, T>(
        json: &'a str,
        read: impl FnOnce(&mut serde_json::Deserializer<StrRead<'a>>) -> serde_json::Result<T>,
    ) -> T {
        match read(&mut serde_json::Deserializer::from_str(json)) {
            Ok(value) => value,
            Err(err) => panic!("read {json}: {err}"),
        }
    }

    keys! {
        /// The keys of a test object.
        TestKey { A = "a", B = "b", }
    }

    #[test]
    fn first_is_the_first_element() {
        let first: u32 = read("[1, 2]", |d| first(d));

        assert_eq!(first, 1);
    }

    #[test]
    fn first_skips_the_rest_whatever_they_are() {
        let first: u32 = read(r#"[1, "two", {"three": 3}]"#, |d| first(d));

        assert_eq!(first, 1);
    }

    #[test]
    fn first_of_an_empty_sequence_is_the_default() {
        let first: String = read("[]", |d| first(d));

        assert_eq!(first, "");
    }

    #[test]
    fn keys_are_read_by_how_they_are_written() {
        let keys: Vec<TestKey> = read(r#"["a", "b", "c"]"#, |d| Vec::deserialize(d));

        assert!(matches!(keys[..], [TestKey::A, TestKey::B, TestKey::Other]));
    }

    #[test]
    fn a_key_can_be_read_once() {
        let mut seen = 0;
        TestKey::A.once::<de::value::Error>(&mut seen).unwrap();
        TestKey::B.once::<de::value::Error>(&mut seen).unwrap();
        let err = TestKey::A.once::<de::value::Error>(&mut seen).unwrap_err();

        assert_eq!(err.to_string(), "duplicate field `a`");
    }

    #[test]
    fn other_keys_can_be_read_again() {
        let mut seen = 0;
        TestKey::Other.once::<de::value::Error>(&mut seen).unwrap();

        assert!(TestKey::Other.once::<de::value::Error>(&mut seen).is_ok());
    }
}

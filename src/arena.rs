//! Arenas: values of a kind kept together, and referred to by where they
//! are rather than by owning them, so that a document of any size is read
//! into a few allocations.

use std::hash::{Hash, Hasher};
use std::marker::PhantomData;

/// The index of a `T` in its arena.
pub(crate) struct Id<T>(u32, PhantomData<fn() -> T>);

impl<T> Id<T> {
    pub(crate) fn new(index: usize) -> Id<T> {
        Id(
            u32::try_from(index).expect("fewer than 2^32 values of a kind"),
            PhantomData,
        )
    }

    pub(crate) fn index(self) -> usize {
        self.0 as usize
    }
}

impl<T> Clone for Id<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl<T> Eq for Id<T> {}

impl<T> Hash for Id<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

/// A string in [`Strings`]. It is not comparable, since two equal strings
/// can be at different places: compare what [`Strings::get`] returns.
#[derive(Clone, Copy, Default)]
pub(crate) struct Str {
    start: u32,
    len: u32,
}

impl Str {
    pub(crate) fn is_empty(self) -> bool {
        self.len == 0
    }

    /// Returns the `len` bytes of the string from byte `offset`.
    fn slice(self, offset: usize, len: usize) -> Str {
        debug_assert!(offset + len <= self.len as usize);
        Str {
            start: self.start + offset as u32,
            len: len as u32,
        }
    }
}

/// Strings, one after another in one buffer.
#[derive(Default)]
pub(crate) struct Strings {
    buf: String,
}

impl Strings {
    /// Adds `s`, and returns where it is.
    pub(crate) fn push(&mut self, s: &str) -> Str {
        if s.is_empty() {
            return Str::default();
        }
        let start = self.buf.len();
        self.buf.push_str(s);
        let end = u32::try_from(self.buf.len()).expect("fewer than 4 GiB of strings");
        Str {
            start: start as u32,
            len: end - start as u32,
        }
    }

    /// Adds `s`, and returns each part of it between `separator`s, as
    /// [`str::split`] does, as a list in `list`.
    pub(crate) fn push_split(&mut self, s: &str, separator: char, list: &mut List<Str>) -> Span<Str> {
        let whole = self.push(s);
        let start = list.start();
        let mut offset = 0;
        for part in s.split(separator) {
            list.push(whole.slice(offset, part.len()));
            offset += part.len() + separator.len_utf8();
        }
        list.finish(start)
    }

    pub(crate) fn get(&self, s: Str) -> &str {
        let start = s.start as usize;
        &self.buf[start..start + s.len as usize]
    }
}

/// A list of `T` in a [`List`].
pub(crate) struct Span<T> {
    start: u32,
    len: u32,
    ty: PhantomData<fn() -> T>,
}

impl<T> Span<T> {
    pub(crate) fn is_empty(self) -> bool {
        self.len == 0
    }
}

impl<T> Clone for Span<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Span<T> {}

impl<T> Default for Span<T> {
    fn default() -> Self {
        Span {
            start: 0,
            len: 0,
            ty: PhantomData,
        }
    }
}

/// An arena of lists of `T`, each one a [`Span`] of `items`.
///
/// A list can be added whole, with [`extend`](List::extend), or built an
/// item at a time. One built an item at a time is kept in `scratch` and
/// moved to `items` once it is done, so that lists can be built while
/// others are, as the values of a document nest. Each list must be
/// finished before the one it is inside.
pub(crate) struct List<T> {
    items: Vec<T>,
    scratch: Vec<T>,
}

impl<T> Default for List<T> {
    fn default() -> Self {
        List {
            items: Vec::new(),
            scratch: Vec::new(),
        }
    }
}

impl<T> List<T> {
    /// Starts a list, and returns what to finish it with.
    pub(crate) fn start(&self) -> usize {
        self.scratch.len()
    }

    /// Adds `item` to the list started last.
    pub(crate) fn push(&mut self, item: T) {
        self.scratch.push(item);
    }

    /// Finishes the list `start` started, and returns it.
    pub(crate) fn finish(&mut self, start: usize) -> Span<T> {
        if self.scratch.len() == start {
            return Span::default();
        }
        let begin = self.items.len();
        self.items.extend(self.scratch.drain(start..));
        self.span(begin)
    }

    /// Adds the list of `items`, and returns it.
    pub(crate) fn extend(&mut self, items: impl IntoIterator<Item = T>) -> Span<T> {
        let begin = self.items.len();
        self.items.extend(items);
        if self.items.len() == begin {
            return Span::default();
        }
        self.span(begin)
    }

    /// Returns the items from `begin` to the end.
    fn span(&self, begin: usize) -> Span<T> {
        let end = u32::try_from(self.items.len()).expect("fewer than 2^32 items of a kind");
        Span {
            start: begin as u32,
            len: end - begin as u32,
            ty: PhantomData,
        }
    }

    pub(crate) fn get(&self, span: Span<T>) -> &[T] {
        let start = span.start as usize;
        &self.items[start..start + span.len as usize]
    }

    pub(crate) fn get_mut(&mut self, span: Span<T>) -> &mut [T] {
        let start = span.start as usize;
        &mut self.items[start..start + span.len as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_are_kept_apart() {
        let mut strings = Strings::default();
        let a = strings.push("ab");
        let empty = strings.push("");
        let b = strings.push("c");

        assert_eq!([strings.get(a), strings.get(empty), strings.get(b)], ["ab", "", "c"]);
    }

    #[test]
    fn split_strings_are_parts_of_the_string() {
        let mut strings = Strings::default();
        let mut list = List::default();
        let parts = strings.push_split("a..bc", '.', &mut list);
        let parts: Vec<&str> = list.get(parts).iter().map(|&s| strings.get(s)).collect();

        assert_eq!(parts, ["a", "", "bc"]);
    }

    #[test]
    fn lists_built_inside_others_are_kept_apart() {
        let mut list = List::default();
        let outer = list.start();
        list.push(1);
        let inner = list.start();
        list.push(2);
        list.push(3);
        let inner = list.finish(inner);
        list.push(4);
        let outer = list.finish(outer);

        assert_eq!(list.get(inner), [2, 3]);
        assert_eq!(list.get(outer), [1, 4]);
    }

    #[test]
    fn lists_added_whole_are_kept_apart() {
        let mut list = List::default();
        let a = list.extend([1, 2]);
        let b = list.extend([3]);
        list.get_mut(a)[0] = 0;

        assert_eq!(list.get(a), [0, 2]);
        assert_eq!(list.get(b), [3]);
    }

    #[test]
    fn an_empty_list_is_empty() {
        let mut list: List<u32> = List::default();
        let start = list.start();
        let built = list.finish(start);
        let added = list.extend([]);

        assert!(built.is_empty() && added.is_empty());
        assert!(list.get(built).is_empty());
    }
}

use forge::{Number, Scalar};

use crate::common::{field, object, parse, responding_with, response_type, scalar};

#[test]
fn primitive_types() {
    for (schema, want) in [
        (r#"{"type": "string"}"#, Scalar::String),
        (r#"{"type": "boolean"}"#, Scalar::Boolean),
        (r#"{"type": "integer"}"#, Scalar::Number(Number::Int)),
        (r#"{"type": "number"}"#, Scalar::Number(Number::Double)),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), want, "{schema}");
    }
}

#[test]
fn number_format_is_its_size() {
    for (schema, want) in [
        (r#"{"type": "integer", "format": "int8"}"#, Number::Int8),
        (r#"{"type": "integer", "format": "int16"}"#, Number::Int16),
        (r#"{"type": "integer", "format": "int32"}"#, Number::Int32),
        (r#"{"type": "integer", "format": "int64"}"#, Number::Int64),
        (r#"{"type": "integer", "format": "uint8"}"#, Number::Uint8),
        (r#"{"type": "integer", "format": "uint16"}"#, Number::Uint16),
        (r#"{"type": "integer", "format": "uint32"}"#, Number::Uint32),
        (r#"{"type": "integer", "format": "uint64"}"#, Number::Uint64),
        (r#"{"type": "number", "format": "float"}"#, Number::Float),
        (r#"{"type": "number", "format": "double"}"#, Number::Double),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn number_format_decides_the_size_whatever_the_type() {
    for (schema, want) in [
        (r#"{"type": "number", "format": "int32"}"#, Number::Int32),
        (r#"{"type": "number", "format": "int64"}"#, Number::Int64),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn number_format_that_is_not_a_size_is_ignored() {
    for (schema, want) in [
        (r#"{"type": "integer", "format": "timestamp"}"#, Number::Int),
        (r#"{"type": "number", "format": "decimal"}"#, Number::Double),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn string_formats() {
    for (schema, want) in [
        (r#"{"type": "string", "format": "date-time"}"#, Scalar::DateTime),
        (r#"{"type": "string", "format": "date"}"#, Scalar::Date),
        (r#"{"type": "string", "format": "byte"}"#, Scalar::Bytes),
        (r#"{"type": "string", "format": "binary"}"#, Scalar::Binary),
        (r#"{"type": "string", "format": "uuid"}"#, Scalar::String),
        (r#"{"type": "string", "format": "uri"}"#, Scalar::String),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), want, "{schema}");
    }
}

#[test]
fn base64_content_encoding_is_bytes() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "string", "contentEncoding": "base64"
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Bytes);
}

#[test]
fn binary_format_is_binary_even_with_base64_content_encoding() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "string", "format": "binary", "contentEncoding": "base64"
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Binary);
}

#[test]
fn json_field_with_binary_format_is_binary_and_byte_format_is_bytes() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {
          "raw": {"type": "string", "format": "binary"},
          "encoded": {"type": "string", "format": "byte"}
        }}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(scalar(field(object, "raw").ty()), Scalar::Binary);
    assert_eq!(scalar(field(object, "encoded").ty()), Scalar::Bytes);
}

#[test]
fn empty_schema_is_unknown() {
    let forge = parse(&responding_with("{}"));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn schema_with_only_annotations_is_unknown() {
    let forge = parse(&responding_with(r#"{"description": "Anything.", "example": 1}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn true_schema_is_unknown() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": true}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

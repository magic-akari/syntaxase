//! Syntaxase's public Zig API.
//!
//! `transform` and `stripTypes` accept source text plus options. Their `_into`
//! variants append to caller-owned output buffers.

const transform_module = @import("transform/root.zig");

pub const AutomaticJSXConfig = transform_module.AutomaticJSXConfig;
pub const ClassicJSXConfig = transform_module.ClassicJSXConfig;
pub const Diagnostic = transform_module.Diagnostic;
pub const DiagnosticLabel = transform_module.DiagnosticLabel;
pub const DiagnosticSeverity = transform_module.DiagnosticSeverity;
pub const DiagnosticSpan = transform_module.DiagnosticSpan;
pub const Error = transform_module.Error;
pub const JSXConfig = transform_module.JSXConfig;
pub const StripTypesLanguage = transform_module.StripTypesLanguage;
pub const StripTypesOptions = transform_module.StripTypesOptions;
pub const TransformResult = transform_module.TransformResult;
pub const TransformOptions = transform_module.TransformOptions;
pub const TransformInfo = transform_module.TransformInfo;

pub const transform = transform_module.transform;
pub const transform_into = transform_module.transform_into;
pub const stripTypes = transform_module.stripTypes;
pub const strip_types_into = transform_module.strip_types_into;

test {
    _ = transform_module;
}

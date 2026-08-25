const std = @import("std");
const parser = @import("parser");
const comment_cursor = @import("comment_cursor.zig");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const jsx_config = @import("jsx_config.zig");
const runtime_edit_buffer = @import("runtime_edit_buffer.zig");
const runtime_name_allocator = @import("runtime_name_allocator.zig");
const runtime_transformer = @import("runtime_transformer.zig");
const source_file = @import("source_file.zig");
const token_cursor = @import("token_cursor.zig");
const type_eraser = @import("type_eraser.zig");
const unicode = @import("unicode.zig");

const Allocator = std.mem.Allocator;

pub const Diagnostic = parser.ast.Diagnostic;
pub const DiagnosticLabel = parser.ast.Label;
pub const DiagnosticSeverity = parser.ast.Severity;
pub const DiagnosticSpan = parser.ast.Span;

/// Automatic JSX runtime configuration.
pub const AutomaticJSXConfig = jsx_config.Automatic;

/// Classic JSX runtime configuration.
pub const ClassicJSXConfig = jsx_config.Classic;

/// JSX parsing and lowering mode.
pub const JSXConfig = jsx_config.Config;

pub const TransformOptions = struct {
    jsx: JSXConfig = .disabled,
};

/// Source language accepted by fixed-width type stripping.
pub const StripTypesLanguage = enum {
    ts,
    tsx,

    fn parser_lang(language: StripTypesLanguage) parser.ast.Lang {
        return switch (language) {
            .ts => .ts,
            .tsx => .tsx,
        };
    }
};

pub const StripTypesOptions = struct {
    lang: StripTypesLanguage = .ts,
};

pub const Error = Allocator.Error;

/// Owned output of a Syntaxase transform.
///
/// Diagnostics are copied directly from Yuku's recovery tree. They describe
/// parser findings without turning them into a secondary Syntaxase rejection
/// policy. `deinit` must receive the allocator passed to `transform` or
/// `stripTypes`.
pub const TransformResult = struct {
    code: []u8,
    diagnostics: []const Diagnostic,

    pub fn deinit(result: *TransformResult, allocator: Allocator) void {
        allocator.free(result.code);
        deinit_diagnostics(allocator, result.diagnostics);
        result.* = undefined;
    }
};

/// Owned metadata returned when transformed code is appended to a
/// caller-managed output buffer.
pub const TransformInfo = struct {
    diagnostics: []const Diagnostic,

    pub fn deinit(info: *TransformInfo, allocator: Allocator) void {
        deinit_diagnostics(allocator, info.diagnostics);
        info.* = undefined;
    }
};

const SourceFile = source_file.SourceFile;

const TransformMode = union(enum) {
    strip_types: StripTypesLanguage,
    transform: JSXConfig,

    fn lang(mode: TransformMode) parser.ast.Lang {
        return switch (mode) {
            .strip_types => |language| language.parser_lang(),
            .transform => |jsx| if (jsx.parses_jsx()) .tsx else .ts,
        };
    }
};

/// Transform TypeScript and optionally JSX into JavaScript.
///
/// The returned code and Yuku diagnostics are owned by the result. The caller
/// must release them with `TransformResult.deinit`.
///
/// Runtime lowering operates directly on Yuku's native tree.
pub fn transform(
    allocator: Allocator,
    source_text: []const u8,
    options: TransformOptions,
) Error!TransformResult {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    var info = try transform_into(allocator, &output, source_text, options);
    errdefer info.deinit(allocator);

    const code = try output.toOwnedSlice(allocator);
    return .{ .code = code, .diagnostics = info.diagnostics };
}

/// Appends transformed JavaScript to `output` and returns owned diagnostics.
/// `allocator` must own the buffer's storage. The buffer retains any bytes
/// present before this call. On error, it may contain a partial rendering and
/// remains owned by the caller.
pub fn transform_into(
    allocator: Allocator,
    output: *std.ArrayList(u8),
    source_text: []const u8,
    options: TransformOptions,
) Error!TransformInfo {
    return run_into(
        allocator,
        output,
        source_text,
        .{ .transform = options.jsx },
    );
}

/// Erase fixed-width TypeScript syntax while preserving source layout.
///
/// Runtime TypeScript constructs that require code generation are handled by
/// later lowering phases rather than this fixed-width pass.
pub fn stripTypes(
    allocator: Allocator,
    source_text: []const u8,
    options: StripTypesOptions,
) Error!TransformResult {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    var info = try strip_types_into(allocator, &output, source_text, options);
    errdefer info.deinit(allocator);

    const code = try output.toOwnedSlice(allocator);
    return .{ .code = code, .diagnostics = info.diagnostics };
}

/// Appends fixed-width TypeScript erasure to `output` and returns owned
/// diagnostics. `allocator` must own the buffer's storage; existing bytes are
/// retained.
pub fn strip_types_into(
    allocator: Allocator,
    output: *std.ArrayList(u8),
    source_text: []const u8,
    options: StripTypesOptions,
) Error!TransformInfo {
    return run_into(allocator, output, source_text, .{ .strip_types = options.lang });
}

fn run_into(
    allocator: Allocator,
    output: *std.ArrayList(u8),
    source_text: []const u8,
    mode: TransformMode,
) Error!TransformInfo {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();

    var file = try SourceFile.parse(scratch, source_text, mode.lang());
    defer file.deinit();

    try transform_file_into(scratch, allocator, &file, mode, output);
    const diagnostics = try clone_diagnostics(allocator, file.tree.diagnostics.items);
    return .{ .diagnostics = diagnostics };
}

fn clone_diagnostics(allocator: Allocator, source: []const Diagnostic) Allocator.Error![]const Diagnostic {
    if (source.len == 0) return &.{};

    const diagnostics = try allocator.alloc(Diagnostic, source.len);
    var initialized: usize = 0;
    errdefer {
        for (diagnostics[0..initialized]) |diagnostic| deinit_diagnostic(allocator, diagnostic);
        allocator.free(diagnostics);
    }

    for (source, diagnostics) |diagnostic, *owned| {
        owned.* = try clone_diagnostic(allocator, diagnostic);
        initialized += 1;
    }
    return diagnostics;
}

fn clone_diagnostic(allocator: Allocator, source: Diagnostic) Allocator.Error!Diagnostic {
    const message = try allocator.dupe(u8, source.message);
    errdefer allocator.free(message);

    const help = if (source.help) |value|
        try allocator.dupe(u8, value)
    else
        null;
    errdefer if (help) |value| allocator.free(value);

    const labels = try clone_diagnostic_labels(allocator, source.labels);
    return .{
        .severity = source.severity,
        .message = message,
        .span = source.span,
        .help = help,
        .labels = labels,
    };
}

fn clone_diagnostic_labels(
    allocator: Allocator,
    source: []const DiagnosticLabel,
) Allocator.Error![]const DiagnosticLabel {
    if (source.len == 0) return &.{};

    const labels = try allocator.alloc(DiagnosticLabel, source.len);
    var initialized: usize = 0;
    errdefer {
        for (labels[0..initialized]) |label| allocator.free(label.message);
        allocator.free(labels);
    }

    for (source, labels) |label, *owned| {
        owned.* = .{
            .span = label.span,
            .message = try allocator.dupe(u8, label.message),
        };
        initialized += 1;
    }
    return labels;
}

fn deinit_diagnostics(allocator: Allocator, diagnostics: []const Diagnostic) void {
    for (diagnostics) |diagnostic| deinit_diagnostic(allocator, diagnostic);
    if (diagnostics.len > 0) allocator.free(diagnostics);
}

fn deinit_diagnostic(allocator: Allocator, diagnostic: Diagnostic) void {
    allocator.free(diagnostic.message);
    if (diagnostic.help) |help| allocator.free(help);
    for (diagnostic.labels) |label| allocator.free(label.message);
    if (diagnostic.labels.len > 0) allocator.free(diagnostic.labels);
}

fn transform_file(
    allocator: Allocator,
    file: *SourceFile,
    mode: TransformMode,
) Error![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try transform_file_into(allocator, allocator, file, mode, &output);
    return output.toOwnedSlice(allocator);
}

fn transform_file_into(
    scratch: Allocator,
    output_allocator: Allocator,
    file: *SourceFile,
    mode: TransformMode,
    output: *std.ArrayList(u8),
) Error!void {
    return switch (mode) {
        .strip_types => strip_file_into(
            scratch,
            output_allocator,
            file,
            output,
        ),
        .transform => |jsx| lower_file_into(
            scratch,
            output_allocator,
            file,
            jsx,
            output,
        ),
    };
}

fn strip_file_into(
    scratch: Allocator,
    output_allocator: Allocator,
    file: *SourceFile,
    output: *std.ArrayList(u8),
) Error!void {
    var edits = fixed_edit_buffer.FixedEditBuffer.init(scratch, file.source());
    defer edits.deinit();
    try type_eraser.erase(&file.tree, file.token_cursor(), &edits);

    var fixed = try edits.seal();
    defer fixed.deinit();
    try fixed.render_into(output, output_allocator);
}

fn lower_file_into(
    scratch: Allocator,
    output_allocator: Allocator,
    file: *SourceFile,
    jsx: JSXConfig,
    output: *std.ArrayList(u8),
) Error!void {
    var edits = fixed_edit_buffer.FixedEditBuffer.init(scratch, file.source());
    defer edits.deinit();
    var runtime_features = runtime_transformer.RuntimeFeatureCollection.init(
        scratch,
        jsx.lowers_jsx(),
    );
    defer runtime_features.deinit();

    try type_eraser.erase_and_collect(
        &file.tree,
        file.token_cursor(),
        &edits,
        &runtime_features,
    );
    try runtime_features.finish_name_collection(&file.tree);

    var fixed = try edits.seal();
    defer fixed.deinit();

    const needs_layout = runtime_features.enums.items.len > 0;
    var runtime = if (needs_layout) blk: {
        try file.ensure_layout();
        break :blk runtime_edit_buffer.RuntimeEditBuffer.init_with_layout(
            scratch,
            &fixed,
            file.source_layout(),
        );
    } else runtime_edit_buffer.RuntimeEditBuffer.init(scratch, &fixed);
    defer runtime.deinit();
    try runtime_transformer.lower(
        scratch,
        file,
        &fixed,
        &runtime,
        &runtime_features,
        jsx,
    );
    try runtime.render_into(output, output_allocator);
}

test "source layout remains lazy when runtime lowering needs no alignment" {
    const allocator = std.testing.allocator;
    const source = "namespace N { export const value: number = 1; }\n";
    var file = try SourceFile.parse(allocator, source, .ts);
    defer file.deinit();

    const code = try transform_file(allocator, &file, .{ .transform = .disabled });
    defer allocator.free(code);

    try std.testing.expect(file.layout == null);
}

test "JSX lowering uses sparse anchors without a full source layout" {
    const allocator = std.testing.allocator;
    const source = "const element = (\n  <div />\n);\n";
    var file = try SourceFile.parse(allocator, source, .tsx);
    defer file.deinit();

    const code = try transform_file(
        allocator,
        &file,
        .{ .transform = .{ .automatic = .{} } },
    );
    defer allocator.free(code);

    try std.testing.expect(file.layout == null);
}

test "aligned runtime lowering initializes source layout" {
    const allocator = std.testing.allocator;
    const source = "enum E {\n  A,\n}\n";
    var file = try SourceFile.parse(allocator, source, .ts);
    defer file.deinit();

    const code = try transform_file(allocator, &file, .{ .transform = .disabled });
    defer allocator.free(code);

    try std.testing.expect(file.layout != null);
}

test "transform lowers JSX with automatic runtime" {
    const allocator = std.testing.allocator;
    const source = "const element = <div />;\n";
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
    try std.testing.expectEqualStrings(
        "const element = _jsx(\"div\", {});\n" ++
            "import { jsx as _jsx } from \"react/jsx-runtime\";\n",
        result.code,
    );
}

test "transform preserves JSX when requested" {
    const allocator = std.testing.allocator;
    const source = "const element: JSX.Element = <div />;\n";
    var result = try transform(allocator, source, .{ .jsx = .preserve });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings("const element              = <div />;\n", result.code);
}

test "automatic JSX lowers attributes children entities and nested expressions" {
    const allocator = std.testing.allocator;
    const source =
        "const element = <Foo enabled label=\"x&amp;y\" {...props} value={input}>" ++
        "hello <span />{condition ? <A /> : <B />}</Foo>;\n";
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = _jsxs(Foo, {\"enabled\": true, \"label\": \"x&y\", ...props, " ++
            "\"value\": input, \"children\": [\"hello \", _jsx(\"span\", {}), " ++
            "condition ? _jsx(A, {}) : _jsx(B, {})]});\n" ++
            "import { jsx as _jsx, jsxs as _jsxs } from \"react/jsx-runtime\";\n",
        result.code,
    );
}

test "automatic JSX handles key fallback development and name collisions" {
    const allocator = std.testing.allocator;
    const source =
        \\const _jsx = 1;
        \\const before = <div key={id} {...props} />;
        \\const after = <div {...props} key="id" />;
        \\
    ;
    var result = try transform(allocator, source, .{
        .jsx = .{ .automatic = .{ .import_source = "custom" } },
    });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const _jsx = 1;\n" ++
            "const before = _jsx2(\"div\", {...props}, id);\n" ++
            "const after = _createElement(\"div\", {...props, \"key\": \"id\"});\n" ++
            "import { createElement as _createElement } from \"custom\";\n" ++
            "import { jsx as _jsx2 } from \"custom/jsx-runtime\";\n",
        result.code,
    );
}

test "automatic JSX helper names handle suffix holes and decoded identifiers" {
    const allocator = std.testing.allocator;
    const source =
        "const _\\u006Asx = 1, _jsx2 = 2, _jsx4 = 4;\n" ++
        "const element = <div />;\n";
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const _\\u006Asx = 1, _jsx2 = 2, _jsx4 = 4;\n" ++
            "const element = _jsx3(\"div\", {});\n" ++
            "import { jsx as _jsx3 } from \"react/jsx-runtime\";\n",
        result.code,
    );
}

test "automatic JSX helper names do not capture component tags" {
    const allocator = std.testing.allocator;
    const source = "const element = <_jsx />;\n";
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = _jsx2(_jsx, {});\n" ++
            "import { jsx as _jsx2 } from \"react/jsx-runtime\";\n",
        result.code,
    );
}

test "reordered JSX spans retain line alignment through sparse anchors" {
    const allocator = std.testing.allocator;
    const source =
        \\const element = (
        \\  <div
        \\    key={<A />}
        \\    {...{child: <B />}}
        \\  />
        \\);
        \\
    ;
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = (\n" ++
            "  _jsx(\"div\", {...{child: \n" ++
            "               \n" ++
            "                _jsx(B, {})}}, _jsx(A, {}))\n" ++
            "    \n" ++
            ");\n" ++
            "import { jsx as _jsx } from \"react/jsx-runtime\";\n",
        result.code,
    );
}

test "classic JSX uses custom factory fragment and spread children" {
    const allocator = std.testing.allocator;
    const source = "const element = <><Foo a />{...items}</>;\n";
    var result = try transform(allocator, source, .{
        .jsx = .{ .classic = .{ .pragma = "h", .pragma_frag = "F" } },
    });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = h(F, null, h(Foo, {\"a\": true}), ...items);\n",
        result.code,
    );
}

test "development JSX always emits jsxDEV metadata arguments" {
    const allocator = std.testing.allocator;
    const source = "const element = <div><A /><B /></div>;\n";
    var result = try transform(allocator, source, .{
        .jsx = .{ .automatic = .{ .development = true } },
    });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = _jsxDEV(\"div\", {\"children\": [_jsxDEV(A, {}, undefined, false), " ++
            "_jsxDEV(B, {}, undefined, false)]}, undefined, true);\n" ++
            "import { jsxDEV as _jsxDEV } from \"react/jsx-dev-runtime\";\n",
        result.code,
    );
}

test "multiline JSX fragments preserve child columns and closing lines" {
    const allocator = std.testing.allocator;
    const source =
        "      const f = (\n" ++
        "        <>\n" ++
        "          <div />\n" ++
        "          <span />\n" ++
        "        </>\n" ++
        "      );\n" ++
        "    ";
    var result = try transform(allocator, source, .{ .jsx = .{ .automatic = .{} } });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "      const f = (\n" ++
            "        _jsxs(_Fragment, {\"children\": [\n" ++
            "          _jsx(\"div\", {}), \n" ++
            "          _jsx(\"span\", {})]})\n" ++
            "           \n" ++
            "      );\n" ++
            "    \n" ++
            "import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from \"react/jsx-runtime\";",
        result.code,
    );
}

test "stripTypes preserves JavaScript UTF-16 width" {
    const allocator = std.testing.allocator;
    const source = "const value: 类型𝒳 = input;\n";
    var result = try stripTypes(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings("const value       = input;\n", result.code);
    try std.testing.expectEqual(unicode.utf16_width(source), unicode.utf16_width(result.code));
}

test "transform lowers a native Yuku enum while stripTypes does not" {
    const allocator = std.testing.allocator;
    const source =
        \\enum Foo {
        \\  A,
        \\  B = "bee",
        \\}
        \\
    ;
    var transformed = try transform(allocator, source, .{});
    defer transformed.deinit(allocator);
    try std.testing.expectEqualStrings(
        "var  Foo;(function(Foo){\n" ++
            "  const A = 0;Foo[Foo[\"A\"]=A]=\"A\";\n" ++
            "  const B=\"bee\";Foo[\"B\"]=B;\n" ++
            "})(Foo||(Foo={}));\n",
        transformed.code,
    );

    var stripped = try stripTypes(allocator, source, .{});
    defer stripped.deinit(allocator);
    try std.testing.expectEqualStrings(source, stripped.code);
}

test "enum lowering aliases duplicate references using Yuku identifier nodes" {
    const allocator = std.testing.allocator;
    const source = "enum E { A = 1, A = 2, B = A }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "var  E;(function(E){const A=1;E[E[\"A\"]=A]=\"A\";" ++
            "const _A=2;E[E[\"A\"]=_A]=\"A\";" ++
            "const B=_A;E[E[\"B\"]=B]=\"B\";})(E||(E={}));\n",
        result.code,
    );
}

test "enum local planning uses Yuku Unicode identifier tables" {
    const allocator = std.testing.allocator;
    const source = "enum E { \"类\" = 1, \"😀\" = 2 }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "var  E;(function(E){const 类=1;E[E[\"类\"]=类]=\"类\";" ++
            "E[E[\"😀\"]=2]=\"😀\";})(E||(E={}));\n",
        result.code,
    );
}

test "transform lowers import-equals through original Yuku spans" {
    const allocator = std.testing.allocator;
    const source =
        \\import A = require("./A");
        \\export import B = Namespace.B;
        \\export import type Gone = require("gone");
        \\
    ;
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const  A = import.sync(\"./A\");\n" ++
            "export const  B = Namespace.B;\n" ++
            "                                          \n",
        result.code,
    );
}

test "transform places parameter-property fields and assignments" {
    const allocator = std.testing.allocator;
    const source =
        \\class Point { constructor(public x: number) {} }
        \\class D extends B { constructor(public x: number) { super(); } }
        \\
    ;
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "class Point {x; constructor(       x        ) {;this.x=x;} }\n" ++
            "class D extends B {x; constructor(       x        ) { super(),this.x=x; } }\n",
        result.code,
    );
}

test "namespace lowering composes exported enum and parameter properties" {
    const allocator = std.testing.allocator;
    const source =
        "namespace N { export enum E { A } " ++
        "export class Box { constructor(public value: number) {} } }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "var       N;(function(N){        " ++
            "var  E;(function(E){const A = 0;E[E[\"A\"]=A]=\"A\";})(E||(E={}));N.E=E;        " ++
            "class Box {value; constructor(       value        ) {;this.value=value;} }N.Box=Box; " ++
            "})(N||(N={}));\n",
        result.code,
    );
}

test "repeated exported enums keep only the first export" {
    const allocator = std.testing.allocator;
    const source = "export enum E { A }\nexport enum E { B }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "export var  E;(function(E){const A = 0;E[E[\"A\"]=A]=\"A\";})(E||(E={}));\n" ++
            "       var  E;(function(E){const B = 0;E[E[\"B\"]=B]=\"B\";})(E||(E={}));\n",
        result.code,
    );
}

test "namespace receiver capture ignores erased type-only names" {
    const allocator = std.testing.allocator;
    const source = "namespace N { interface N {} export function f() {} }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "var       N;(function(N){                       function f() {}N.f=f; })(N||(N={}));\n",
        result.code,
    );
}

test "namespace receiver capture respects runtime scope boundaries" {
    const allocator = std.testing.allocator;

    var nested_reference = try transform(
        allocator,
        "namespace N { function f() { return N; } }\n",
        .{},
    );
    defer nested_reference.deinit(allocator);
    try std.testing.expect(std.mem.indexOf(u8, nested_reference.code, "(function(N){") != null);

    var top_level_reference = try transform(
        allocator,
        "namespace N { const value = N; }\n",
        .{},
    );
    defer top_level_reference.deinit(allocator);
    try std.testing.expect(std.mem.indexOf(u8, top_level_reference.code, "(function(N1){") != null);

    var top_level_declaration = try transform(
        allocator,
        "namespace N { function N() {} }\n",
        .{},
    );
    defer top_level_declaration.deinit(allocator);
    try std.testing.expect(std.mem.indexOf(u8, top_level_declaration.code, "(function(N1){") != null);
}

test "enum fragments compose nested parameter-property insertions" {
    const allocator = std.testing.allocator;
    const source = "enum Outer { A = (class { constructor(public x: number) {} }) }\n";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "var  Outer;(function(Outer){" ++
            "const A=(class {x; constructor(       x        ) {;this.x=x;} });" ++
            "Outer[Outer[\"A\"]=A]=\"A\";" ++
            "})(Outer||(Outer={}));\n",
        result.code,
    );
}

test "transform returns Yuku diagnostics with recovery code" {
    const allocator = std.testing.allocator;
    const source = "const = ;";
    var result = try transform(allocator, source, .{});
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(source, result.code);
    try std.testing.expect(result.diagnostics.len > 0);

    const diagnostic = result.diagnostics[0];
    try std.testing.expectEqual(DiagnosticSeverity.@"error", diagnostic.severity);
    try std.testing.expect(diagnostic.message.len > 0);
    try std.testing.expect(diagnostic.span.start <= diagnostic.span.end);
}

test "diagnostic results own messages help and labels" {
    const allocator = std.testing.allocator;
    var message = [_]u8{ 'm', 'e', 's', 's', 'a', 'g', 'e' };
    var help = [_]u8{ 'h', 'e', 'l', 'p' };
    var label_message = [_]u8{ 'l', 'a', 'b', 'e', 'l' };
    var labels = [_]DiagnosticLabel{.{
        .span = .{ .start = 2, .end = 3 },
        .message = &label_message,
    }};
    var source = [_]Diagnostic{.{
        .severity = .warning,
        .message = &message,
        .span = .{ .start = 1, .end = 4 },
        .help = &help,
        .labels = &labels,
    }};

    const diagnostics = try clone_diagnostics(allocator, &source);
    defer deinit_diagnostics(allocator, diagnostics);

    message[0] = 'X';
    help[0] = 'X';
    label_message[0] = 'X';
    try std.testing.expectEqualStrings("message", diagnostics[0].message);
    try std.testing.expectEqualStrings("help", diagnostics[0].help.?);
    try std.testing.expectEqualStrings("label", diagnostics[0].labels[0].message);
}

test {
    _ = comment_cursor;
    _ = fixed_edit_buffer;
    _ = jsx_config;
    _ = runtime_edit_buffer;
    _ = runtime_name_allocator;
    _ = runtime_transformer;
    _ = source_file;
    _ = token_cursor;
    _ = type_eraser;
    _ = unicode;
}

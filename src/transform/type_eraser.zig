const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const namespace_semantics = @import("namespace_semantics.zig");
const runtime_transformer = @import("runtime_transformer.zig");
const source_layout = @import("source_layout.zig");
const token_cursor = @import("token_cursor.zig");

const Action = parser.traverser.Action;
const Allocator = std.mem.Allocator;
const Ctx = parser.traverser.basic.Ctx;
const NodeIndex = parser.ast.NodeIndex;

/// Collects the first source-preserving TypeScript erasures directly from the
/// native Yuku AST. All registered positions remain original UTF-8 byte spans.
pub fn erase(
    tree: *const parser.ast.Tree,
    tokens: token_cursor.TokenCursor,
    edits: *fixed_edit_buffer.FixedEditBuffer,
) Allocator.Error!void {
    return erase_internal(tree, tokens, edits, null);
}

/// Adds runtime feature collection to the fixed eraser's existing Yuku walk.
/// No second whole-tree traversal is required by `transform`.
pub fn erase_and_collect(
    tree: *const parser.ast.Tree,
    tokens: token_cursor.TokenCursor,
    edits: *fixed_edit_buffer.FixedEditBuffer,
    runtime: *runtime_transformer.RuntimeFeatureCollection,
) Allocator.Error!void {
    return erase_internal(tree, tokens, edits, runtime);
}

fn erase_internal(
    tree: *const parser.ast.Tree,
    tokens: token_cursor.TokenCursor,
    edits: *fixed_edit_buffer.FixedEditBuffer,
    runtime: ?*runtime_transformer.RuntimeFeatureCollection,
) Allocator.Error!void {
    var visitor: Visitor = .{
        .edits = edits,
        .tokens = tokens,
        .runtime = runtime,
    };
    defer visitor.exported_enums.deinit(edits.allocator);
    try parser.traverser.basic.traverse(Visitor, tree, &visitor);
}

const Visitor = struct {
    edits: *fixed_edit_buffer.FixedEditBuffer,
    tokens: token_cursor.TokenCursor,
    runtime: ?*runtime_transformer.RuntimeFeatureCollection,
    exported_enums: std.StringHashMapUnmanaged(void) = .empty,

    pub fn enter_node(
        self: *Visitor,
        data: parser.ast.NodeData,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (self.runtime) |runtime| try runtime.collect_node(data, index, ctx);
        return .proceed;
    }

    pub fn exit_node(
        self: *Visitor,
        data: parser.ast.NodeData,
        index: NodeIndex,
        ctx: *Ctx,
    ) void {
        if (self.runtime) |runtime| runtime.exit_node(data, index, ctx);
    }

    pub fn enter_ts_type_annotation(
        self: *Visitor,
        _: parser.ast.TSTypeAnnotation,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_type_parameter_declaration(
        self: *Visitor,
        _: parser.ast.TSTypeParameterDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_type_parameter_instantiation(
        self: *Visitor,
        _: parser.ast.TSTypeParameterInstantiation,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_type_alias_declaration(
        self: *Visitor,
        _: parser.ast.TSTypeAliasDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_interface_declaration(
        self: *Visitor,
        _: parser.ast.TSInterfaceDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_namespace_export_declaration(
        self: *Visitor,
        _: parser.ast.TSNamespaceExportDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_as_expression(
        self: *Visitor,
        expression: parser.ast.TSAsExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_suffix_expression(expression.expression, index, ctx);
        return .proceed;
    }

    pub fn enter_ts_satisfies_expression(
        self: *Visitor,
        expression: parser.ast.TSSatisfiesExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_suffix_expression(expression.expression, index, ctx);
        return .proceed;
    }

    pub fn enter_ts_non_null_expression(
        self: *Visitor,
        expression: parser.ast.TSNonNullExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_suffix_expression(expression.expression, index, ctx);
        return .proceed;
    }

    pub fn enter_ts_type_assertion(
        self: *Visitor,
        assertion: parser.ast.TSTypeAssertion,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        const assertion_span = ctx.tree.span(index);
        const expression_span = ctx.tree.span(assertion.expression);
        try self.edits.add_blank(assertion_span.start, expression_span.start);
        return .proceed;
    }

    pub fn enter_arrow_function_expression(
        self: *Visitor,
        arrow: parser.ast.ArrowFunctionExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.move_opening_parenthesis_across_multiline_type_parameters(arrow, index, ctx);
        try self.move_closing_parenthesis_across_multiline_return_type(arrow, ctx);
        return .proceed;
    }

    pub fn enter_function(
        self: *Visitor,
        function: parser.ast.Function,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (function.type != .ts_declare_function) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_class(
        self: *Visitor,
        class: parser.ast.Class,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (class.declare) {
            try self.erase_whole_node(index, ctx);
            return .skip;
        }

        const class_span = ctx.tree.span(index);
        const modifier_start = last_decorator_end(
            ctx.tree,
            class.decorators,
            class_span.start,
        );
        const identifier_start = if (class.id != .null)
            ctx.tree.span(class.id).start
        else
            ctx.tree.span(class.body).start;

        if (class.abstract) {
            _ = try self.erase_keyword(modifier_start, identifier_start, "abstract");
        }

        const implemented = ctx.tree.extra(class.implements);
        if (implemented.len > 0) {
            const first = ctx.tree.span(implemented[0]);
            const last = ctx.tree.span(implemented[implemented.len - 1]);
            if (self.tokens.find_backward(class_span.start, first.start, "implements")) |keyword| {
                try self.edits.add_blank(keyword.span.start, last.end);
            }
        }
        return .proceed;
    }

    pub fn enter_property_definition(
        self: *Visitor,
        property: parser.ast.PropertyDefinition,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (property.declare or property.abstract) {
            try self.erase_whole_node(index, ctx);
            return .skip;
        }

        try self.erase_property_syntax(property, index, ctx);
        return .proceed;
    }

    pub fn enter_method_definition(
        self: *Visitor,
        method: parser.ast.MethodDefinition,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        const function = switch (ctx.tree.data(method.value)) {
            .function => |value| value,
            else => return .proceed,
        };
        if (method.abstract or function.body == .null) {
            try self.erase_whole_node(index, ctx);
            return .skip;
        }

        try self.erase_method_syntax(method, index, ctx);
        return .proceed;
    }

    pub fn enter_variable_declaration(
        self: *Visitor,
        declaration: parser.ast.VariableDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (!declaration.declare) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_enum_declaration(
        self: *Visitor,
        declaration: parser.ast.TSEnumDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (!declaration.declare) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_module_declaration(
        self: *Visitor,
        declaration: parser.ast.TSModuleDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (!namespace_semantics.is_type_only_module(ctx.tree, declaration)) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_global_declaration(
        self: *Visitor,
        _: parser.ast.TSGlobalDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_import_equals_declaration(
        self: *Visitor,
        declaration: parser.ast.TSImportEqualsDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (declaration.import_kind != .type) return .skip;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_ts_index_signature(
        self: *Visitor,
        _: parser.ast.TSIndexSignature,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_formal_parameters(
        self: *Visitor,
        parameters: parser.ast.FormalParameters,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        const items = ctx.tree.extra(parameters.items);
        if (items.len == 0) return .proceed;

        const first_parameter = switch (ctx.tree.data(items[0])) {
            .formal_parameter => |parameter| parameter.pattern,
            else => return .proceed,
        };
        if (ctx.tree.data(first_parameter) != .ts_this_parameter) return .proceed;

        const first_span = ctx.tree.span(items[0]);
        const next_index = if (items.len > 1)
            items[1]
        else
            parameters.rest;
        if (next_index != .null) {
            const next_span = ctx.tree.span(next_index);
            if (self.tokens.find_forward(first_span.end, next_span.start, ",")) |comma| {
                try self.edits.add_blank(first_span.start, comma.span.end);
                return .proceed;
            }
        } else {
            const parameters_span = ctx.tree.span(index);
            if (self.tokens.find_forward(first_span.end, parameters_span.end, ",")) |comma| {
                try self.edits.add_blank(first_span.start, comma.span.end);
                return .proceed;
            }
        }
        try self.edits.add_blank(first_span.start, first_span.end);
        return .proceed;
    }

    pub fn enter_ts_parameter_property(
        self: *Visitor,
        property: parser.ast.TSParameterProperty,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        const span = ctx.tree.span(index);
        const parameter_start = ctx.tree.span(property.parameter).start;
        if (property.accessibility != .none) {
            _ = try self.erase_keyword(
                span.start,
                parameter_start,
                property.accessibility.toString(),
            );
        }
        if (property.readonly) {
            _ = try self.erase_keyword(span.start, parameter_start, "readonly");
        }
        if (property.override) {
            _ = try self.erase_keyword(span.start, parameter_start, "override");
        }
        return .proceed;
    }

    pub fn enter_variable_declarator(
        self: *Visitor,
        declarator: parser.ast.VariableDeclarator,
        _: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (!declarator.definite) return .proceed;

        const id_span = ctx.tree.span(declarator.id);
        const annotation = pattern_type_annotation(ctx.tree, declarator.id);
        const marker_end = if (annotation != .null)
            ctx.tree.span(annotation).start
        else
            id_span.end;
        if (self.tokens.find_backward(id_span.start, marker_end, "!")) |marker| {
            try self.edits.add_blank(marker.span.start, marker.span.end);
        }
        return .proceed;
    }

    pub fn enter_binding_identifier(
        self: *Visitor,
        identifier: parser.ast.BindingIdentifier,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_optional_pattern(identifier.optional, identifier.type_annotation, index, ctx);
        return .proceed;
    }

    pub fn enter_assignment_pattern(
        self: *Visitor,
        pattern: parser.ast.AssignmentPattern,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_optional_pattern(pattern.optional, pattern.type_annotation, index, ctx);
        return .proceed;
    }

    pub fn enter_binding_rest_element(
        self: *Visitor,
        element: parser.ast.BindingRestElement,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_optional_pattern(element.optional, element.type_annotation, index, ctx);
        return .proceed;
    }

    pub fn enter_array_pattern(
        self: *Visitor,
        pattern: parser.ast.ArrayPattern,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_optional_pattern(pattern.optional, pattern.type_annotation, index, ctx);
        return .proceed;
    }

    pub fn enter_object_pattern(
        self: *Visitor,
        pattern: parser.ast.ObjectPattern,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_optional_pattern(pattern.optional, pattern.type_annotation, index, ctx);
        return .proceed;
    }

    pub fn enter_import_declaration(
        self: *Visitor,
        declaration: parser.ast.ImportDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (declaration.import_kind == .type) {
            try self.erase_whole_node(index, ctx);
            return .skip;
        }

        try self.erase_import_specifiers(declaration, index, ctx);
        return .proceed;
    }

    pub fn enter_export_named_declaration(
        self: *Visitor,
        declaration: parser.ast.ExportNamedDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (declaration.export_kind == .type or
            is_whole_type_declaration(ctx.tree, declaration.declaration))
        {
            try self.erase_whole_node(index, ctx);
            return .skip;
        }

        if (self.runtime != null and declaration.declaration != .null and
            namespace_semantics.is_supported_runtime_export_declaration(ctx.tree, declaration.declaration) and
            is_inside_runtime_namespace(ctx))
        {
            const wrapper_span = ctx.tree.span(index);
            const declaration_span = ctx.tree.span(declaration.declaration);
            if (self.tokens.find_forward(wrapper_span.start, declaration_span.start, "export")) |token| {
                try self.edits.add_blank(token.span.start, token.span.end);
            }
        } else if (self.runtime != null and declaration.declaration != .null) {
            const enum_declaration = switch (ctx.tree.data(declaration.declaration)) {
                .ts_enum_declaration => |value| value,
                else => null,
            };
            if (enum_declaration) |value| {
                if (!value.declare) {
                    const name = switch (ctx.tree.data(value.id)) {
                        .binding_identifier => |identifier| ctx.tree.string(identifier.name),
                        else => ctx.tree.source[ctx.tree.span(value.id).start..ctx.tree.span(value.id).end],
                    };
                    const entry = try self.exported_enums.getOrPut(self.edits.allocator, name);
                    if (entry.found_existing) {
                        const wrapper_span = ctx.tree.span(index);
                        const enum_span = ctx.tree.span(declaration.declaration);
                        if (self.tokens.find_forward(wrapper_span.start, enum_span.start, "export")) |token| {
                            try self.edits.add_blank(token.span.start, token.span.end);
                        }
                    }
                }
            }
        }

        try self.erase_export_specifiers(declaration, index, ctx);
        return .proceed;
    }

    pub fn enter_export_all_declaration(
        self: *Visitor,
        declaration: parser.ast.ExportAllDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (declaration.export_kind != .type) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    pub fn enter_export_default_declaration(
        self: *Visitor,
        declaration: parser.ast.ExportDefaultDeclaration,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        if (!is_whole_type_declaration(ctx.tree, declaration.declaration)) return .proceed;

        try self.erase_whole_node(index, ctx);
        return .skip;
    }

    fn erase_node(self: *Visitor, index: NodeIndex, ctx: *Ctx) Allocator.Error!void {
        const span = ctx.tree.span(index);
        try self.edits.add_blank(span.start, span.end);
    }

    fn erase_whole_node(self: *Visitor, index: NodeIndex, ctx: *Ctx) Allocator.Error!void {
        const span = ctx.tree.span(index);
        try self.edits.add_blank(span.start, span.end);
        if (!needs_semicolon_before_erasure(index, ctx, self.tokens.source)) return;

        const first = self.tokens.first_in_range(span.start, span.end) orelse return;
        try self.edits.add_substitution(first.span.start, .semicolon);
    }

    fn erase_property_syntax(
        self: *Visitor,
        property: parser.ast.PropertyDefinition,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const property_span = ctx.tree.span(index);
        const key_span = ctx.tree.span(property.key);
        const search_start = last_decorator_end(
            ctx.tree,
            property.decorators,
            property_span.start,
        );

        var first_modifier_start = key_span.start;
        var has_removable_modifier = false;
        if (property.readonly) {
            if (try self.erase_keyword(search_start, key_span.start, "readonly")) |start| {
                first_modifier_start = @min(first_modifier_start, start);
                has_removable_modifier = true;
            }
        }
        if (property.override) {
            if (try self.erase_keyword(search_start, key_span.start, "override")) |start| {
                first_modifier_start = @min(first_modifier_start, start);
                has_removable_modifier = true;
            }
        }
        if (property.accessibility != .none) {
            if (try self.erase_keyword(
                search_start,
                key_span.start,
                property.accessibility.toString(),
            )) |start| {
                first_modifier_start = @min(first_modifier_start, start);
                has_removable_modifier = true;
            }
        }

        if (property.computed and has_removable_modifier and property.decorators.len == 0) {
            try self.edits.add_substitution(first_modifier_start, .semicolon);
        }

        var marker_end = property_span.end;
        if (property.type_annotation != .null) {
            marker_end = @min(marker_end, ctx.tree.span(property.type_annotation).start);
        }
        if (property.value != .null) {
            marker_end = @min(marker_end, ctx.tree.span(property.value).start);
        }
        if (property.optional) {
            try self.erase_punctuation(key_span.end, marker_end, "?");
        }
        if (property.definite) {
            try self.erase_punctuation(key_span.end, marker_end, "!");
        }
    }

    fn erase_method_syntax(
        self: *Visitor,
        method: parser.ast.MethodDefinition,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const method_span = ctx.tree.span(index);
        const key_span = ctx.tree.span(method.key);
        const search_start = last_decorator_end(
            ctx.tree,
            method.decorators,
            method_span.start,
        );
        var first_modifier_start = key_span.start;
        var has_removable_modifier = false;
        if (method.override) {
            if (try self.erase_keyword(search_start, key_span.start, "override")) |start| {
                first_modifier_start = @min(first_modifier_start, start);
                has_removable_modifier = true;
            }
        }
        if (method.accessibility != .none) {
            if (try self.erase_keyword(
                search_start,
                key_span.start,
                method.accessibility.toString(),
            )) |start| {
                first_modifier_start = @min(first_modifier_start, start);
                has_removable_modifier = true;
            }
        }
        if (method.computed and has_removable_modifier and method.decorators.len == 0) {
            try self.edits.add_substitution(first_modifier_start, .semicolon);
        }
        if (method.optional) {
            const function_start = ctx.tree.span(method.value).start;
            try self.erase_punctuation(key_span.end, function_start, "?");
        }
    }

    fn erase_keyword(
        self: *Visitor,
        start: u32,
        end: u32,
        keyword: []const u8,
    ) Allocator.Error!?u32 {
        const token = self.tokens.find_forward(start, end, keyword) orelse return null;
        try self.edits.add_blank(token.span.start, token.span.end);
        return token.span.start;
    }

    fn erase_punctuation(
        self: *Visitor,
        start: u32,
        end: u32,
        punctuation: []const u8,
    ) Allocator.Error!void {
        const token = self.tokens.find_forward(start, end, punctuation) orelse return;
        try self.edits.add_blank(token.span.start, token.span.end);
    }

    fn erase_optional_pattern(
        self: *Visitor,
        optional: bool,
        type_annotation: NodeIndex,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        if (!optional) return;

        const span = ctx.tree.span(index);
        const marker_end = if (type_annotation != .null)
            ctx.tree.span(type_annotation).start
        else
            span.end;
        if (self.tokens.find_backward(span.start, marker_end, "?")) |marker| {
            try self.edits.add_blank(marker.span.start, marker.span.end);
        }
    }

    fn erase_suffix_expression(
        self: *Visitor,
        expression_index: NodeIndex,
        wrapper_index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const expression_span = ctx.tree.span(expression_index);
        const wrapper_span = ctx.tree.span(wrapper_index);

        const changes_grouping = assertion_would_change_binary_grouping(
            expression_index,
            wrapper_index,
            ctx,
        );
        if (assertion_needs_exponent_parentheses(
            expression_index,
            wrapper_index,
            changes_grouping,
            ctx,
        )) {
            try self.preserve_exponent_assertion_grouping(
                expression_span,
                wrapper_span,
            );
        }

        try self.edits.add_blank(expression_span.end, wrapper_span.end);
        if (self.ends_containing_statement(wrapper_span, ctx)) {
            try self.edits.add_substitution(expression_span.end, .semicolon);
        }
    }

    fn move_opening_parenthesis_across_multiline_type_parameters(
        self: *Visitor,
        arrow: parser.ast.ArrowFunctionExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        if (arrow.type_parameters == .null) return;
        if (!self.has_line_sensitive_arrow_prefix(arrow, index, ctx)) return;

        const type_parameters = ctx.tree.span(arrow.type_parameters);
        const parameters = ctx.tree.span(arrow.params);
        if (!source_layout.contains_line_terminator(
            self.tokens.source[type_parameters.start..parameters.start],
        )) return;

        const opening = self.tokens.find_forward(parameters.start, parameters.end, "(") orelse return;
        try self.edits.add_substitution(type_parameters.start, .left_parenthesis);
        try self.edits.add_blank(opening.span.start, opening.span.end);
    }

    fn has_line_sensitive_arrow_prefix(
        self: *const Visitor,
        arrow: parser.ast.ArrowFunctionExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) bool {
        if (arrow.async) return true;

        const parent_index = ctx.path.parent() orelse return false;
        const keyword: []const u8 = switch (ctx.tree.data(parent_index)) {
            .return_statement => |statement| if (statement.argument == index) "return" else return false,
            .throw_statement => |statement| if (statement.argument == index) "throw" else return false,
            .yield_expression => |expression| if (expression.argument == index) "yield" else return false,
            else => return false,
        };
        const parent_span = ctx.tree.span(parent_index);
        const type_parameters = ctx.tree.span(arrow.type_parameters);
        const keyword_end = parent_span.start + @as(u32, @intCast(keyword.len));
        return !source_layout.contains_line_terminator(
            self.tokens.source[keyword_end..type_parameters.start],
        );
    }

    fn move_closing_parenthesis_across_multiline_return_type(
        self: *Visitor,
        arrow: parser.ast.ArrowFunctionExpression,
        ctx: *Ctx,
    ) Allocator.Error!void {
        if (arrow.return_type == .null) return;

        const parameters = ctx.tree.span(arrow.params);
        const return_type = ctx.tree.span(arrow.return_type);
        const body = ctx.tree.span(arrow.body);
        const arrow_token = self.tokens.find_forward(return_type.end, body.start, "=>") orelse return;
        if (!source_layout.contains_line_terminator(
            self.tokens.source[parameters.end..arrow_token.span.start],
        )) return;

        const final_type_token = self.tokens.last_in_range(
            return_type.start,
            return_type.end,
        ) orelse return;
        const replacement_start = previous_scalar_start(
            self.tokens.source,
            final_type_token.span.end,
        );
        try self.edits.add_blank(parameters.end - 1, parameters.end);
        try self.edits.add_substitution_range(
            replacement_start,
            final_type_token.span.end,
            .right_parenthesis,
        );
    }

    fn preserve_exponent_assertion_grouping(
        self: *Visitor,
        expression_span: parser.ast.Span,
        wrapper_span: parser.ast.Span,
    ) Allocator.Error!void {
        if (expression_span.start == 0 or wrapper_span.end <= expression_span.end) return;

        const source = self.tokens.source;
        const opening = expression_span.start - 1;
        if (!is_horizontal_whitespace(source[opening])) return;

        const closing_start = previous_scalar_start(source, wrapper_span.end);
        if (closing_start < expression_span.end) return;
        if (source_layout.contains_line_terminator(source[closing_start..wrapper_span.end])) return;

        try self.edits.add_substitution(opening, .left_parenthesis);
        try self.edits.add_substitution_range(
            closing_start,
            wrapper_span.end,
            .right_parenthesis,
        );
    }

    fn ends_containing_statement(
        self: *const Visitor,
        wrapper_span: parser.ast.Span,
        ctx: *Ctx,
    ) bool {
        const source = self.tokens.source;
        if (wrapper_span.end < source.len and source[wrapper_span.end] == ';') return false;

        var depth: usize = 1;
        while (ctx.path.ancestor(depth)) |ancestor_index| : (depth += 1) {
            const ancestor_span = ctx.tree.span(ancestor_index);
            if (ancestor_span.end != wrapper_span.end) continue;

            const ancestor = ctx.tree.data(ancestor_index);
            if (ancestor.isStatement() or ancestor == .property_definition) return true;
        }
        return false;
    }

    fn erase_import_specifiers(
        self: *Visitor,
        declaration: parser.ast.ImportDeclaration,
        container_index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const specifiers = ctx.tree.extra(declaration.specifiers);

        for (specifiers, 0..) |specifier_index, position| {
            const specifier = switch (ctx.tree.data(specifier_index)) {
                .import_specifier => |value| value,
                else => continue,
            };
            if (specifier.import_kind != .type) continue;

            const next = next_import_specifier(ctx.tree, specifiers, position + 1);
            try self.erase_list_item(specifier_index, next, container_index, ctx);
        }
    }

    fn erase_export_specifiers(
        self: *Visitor,
        declaration: parser.ast.ExportNamedDeclaration,
        container_index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const specifiers = ctx.tree.extra(declaration.specifiers);

        for (specifiers, 0..) |specifier_index, position| {
            const specifier = switch (ctx.tree.data(specifier_index)) {
                .export_specifier => |value| value,
                else => continue,
            };
            if (specifier.export_kind != .type) continue;

            const next = if (position + 1 < specifiers.len)
                specifiers[position + 1]
            else
                NodeIndex.null;
            try self.erase_list_item(specifier_index, next, container_index, ctx);
        }
    }

    fn erase_list_item(
        self: *Visitor,
        item_index: NodeIndex,
        next_index: NodeIndex,
        container_index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const item = ctx.tree.span(item_index);
        const container = ctx.tree.span(container_index);
        const gap_end = if (next_index != .null)
            ctx.tree.span(next_index).start
        else if (self.tokens.find_forward(item.end, container.end, "}")) |closing|
            closing.span.start
        else
            container.end;

        if (self.tokens.find_forward(item.end, gap_end, ",")) |comma| {
            try self.edits.add_blank(item.start, comma.span.end);
        } else {
            try self.edits.add_blank(item.start, item.end);
        }
    }
};

const BinaryInfo = struct {
    left: NodeIndex,
    precedence: u8,
    exponent: bool,
};

fn assertion_would_change_binary_grouping(
    expression_index: NodeIndex,
    wrapper_index: NodeIndex,
    ctx: *Ctx,
) bool {
    const expression = asserted_binary_info(ctx.tree, expression_index) orelse return false;
    const parent_index = ctx.path.parent() orelse return false;
    const parent = binary_info(ctx.tree.data(parent_index)) orelse return false;
    if (parent.left != wrapper_index) return false;

    if (parent.precedence > expression.precedence) return true;
    return parent.precedence == expression.precedence and
        (expression.exponent or parent.exponent);
}

fn assertion_needs_exponent_parentheses(
    expression_index: NodeIndex,
    wrapper_index: NodeIndex,
    changes_grouping: bool,
    ctx: *Ctx,
) bool {
    const parent_index = ctx.path.parent() orelse return false;
    const parent = switch (ctx.tree.data(parent_index)) {
        .binary_expression => |binary| binary,
        else => return false,
    };
    if (parent.left != wrapper_index or parent.operator != .exponent) return false;

    return switch (ctx.tree.data(expression_index)) {
        .unary_expression, .await_expression => true,
        else => changes_grouping,
    };
}

fn asserted_binary_info(tree: *const parser.ast.Tree, initial: NodeIndex) ?BinaryInfo {
    var index = initial;
    while (true) {
        const data = tree.data(index);
        switch (data) {
            .ts_as_expression => |expression| index = expression.expression,
            .ts_satisfies_expression => |expression| index = expression.expression,
            else => return binary_info(data),
        }
    }
}

fn binary_info(data: parser.ast.NodeData) ?BinaryInfo {
    return switch (data) {
        .binary_expression => |expression| .{
            .left = expression.left,
            .precedence = binary_precedence(expression.operator),
            .exponent = expression.operator == .exponent,
        },
        .logical_expression => |expression| .{
            .left = expression.left,
            .precedence = logical_precedence(expression.operator),
            .exponent = false,
        },
        else => null,
    };
}

fn binary_precedence(operator: parser.ast.BinaryOperator) u8 {
    return switch (operator) {
        .exponent => 15,
        .multiply, .divide, .modulo => 14,
        .add, .subtract => 13,
        .left_shift, .right_shift, .unsigned_right_shift => 12,
        .less_than,
        .less_than_or_equal,
        .greater_than,
        .greater_than_or_equal,
        .instanceof,
        .in,
        => 11,
        .equal, .not_equal, .strict_equal, .strict_not_equal => 10,
        .bitwise_and => 9,
        .bitwise_xor => 8,
        .bitwise_or => 7,
    };
}

fn logical_precedence(operator: parser.ast.LogicalOperator) u8 {
    return switch (operator) {
        .@"and" => 6,
        .@"or" => 5,
        .nullish_coalescing => 4,
    };
}

fn previous_scalar_start(source: []const u8, end: u32) u32 {
    std.debug.assert(end > 0);
    var start: usize = end - 1;
    while (start > 0 and source[start] & 0xc0 == 0x80) : (start -= 1) {}
    return @intCast(start);
}

fn is_horizontal_whitespace(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\x0b' or byte == '\x0c';
}

fn needs_semicolon_before_erasure(
    index: NodeIndex,
    ctx: *Ctx,
    source: []const u8,
) bool {
    const parent_index = ctx.path.parent() orelse return false;
    const parent = ctx.tree.data(parent_index);
    if (is_required_statement_slot(parent, index)) return true;

    const statements = statement_list(ctx.tree, parent) orelse return false;
    var position: ?usize = null;
    for (statements, 0..) |statement, statement_index| {
        if (statement == index) {
            position = statement_index;
            break;
        }
    }

    var cursor = position orelse return false;
    while (cursor > 0) {
        cursor -= 1;
        const previous = statements[cursor];
        if (previous == .null or is_erasable_statement(ctx.tree, previous)) continue;

        const previous_span = ctx.tree.span(previous);
        if (previous_span.end == 0) return false;
        return source[previous_span.end - 1] != ';';
    }
    return false;
}

fn statement_list(
    tree: *const parser.ast.Tree,
    parent: parser.ast.NodeData,
) ?[]const NodeIndex {
    return switch (parent) {
        .program => |node| tree.extra(node.body),
        .function_body => |node| tree.extra(node.body),
        .block_statement => |node| tree.extra(node.body),
        .class_body => |node| tree.extra(node.body),
        .ts_module_block => |node| tree.extra(node.body),
        .static_block => |node| tree.extra(node.body),
        .switch_case => |node| tree.extra(node.consequent),
        else => null,
    };
}

fn is_required_statement_slot(parent: parser.ast.NodeData, index: NodeIndex) bool {
    return switch (parent) {
        .if_statement => |node| node.consequent == index or node.alternate == index,
        .labeled_statement => |node| node.body == index,
        .while_statement => |node| node.body == index,
        .do_while_statement => |node| node.body == index,
        .for_statement => |node| node.body == index,
        .for_in_statement => |node| node.body == index,
        .for_of_statement => |node| node.body == index,
        else => false,
    };
}

fn is_inside_runtime_namespace(ctx: *const Ctx) bool {
    var depth: usize = 1;
    while (ctx.path.ancestor(depth)) |ancestor| : (depth += 1) {
        switch (ctx.tree.data(ancestor)) {
            .ts_module_declaration => |declaration| {
                if (!namespace_semantics.is_type_only_module(ctx.tree, declaration)) return true;
            },
            else => {},
        }
    }
    return false;
}

fn is_erasable_statement(tree: *const parser.ast.Tree, index: NodeIndex) bool {
    return switch (tree.data(index)) {
        .ts_type_alias_declaration,
        .ts_interface_declaration,
        .ts_namespace_export_declaration,
        .ts_index_signature,
        .ts_global_declaration,
        => true,
        .function => |node| node.type == .ts_declare_function,
        .class => |node| node.declare,
        .property_definition => |node| node.declare or node.abstract,
        .method_definition => |node| node.abstract or switch (tree.data(node.value)) {
            .function => |function| function.body == .null,
            else => false,
        },
        .variable_declaration => |node| node.declare,
        .ts_enum_declaration => |node| node.declare,
        .ts_module_declaration => |node| namespace_semantics.is_type_only_module(tree, node),
        .ts_import_equals_declaration => |node| node.import_kind == .type,
        .import_declaration => |node| node.import_kind == .type,
        .export_named_declaration => |node| node.export_kind == .type or
            is_whole_type_declaration(tree, node.declaration),
        .export_default_declaration => |node| is_whole_type_declaration(tree, node.declaration),
        .export_all_declaration => |node| node.export_kind == .type,
        else => false,
    };
}

fn last_decorator_end(
    tree: *const parser.ast.Tree,
    decorators: parser.ast.IndexRange,
    fallback: u32,
) u32 {
    const indices = tree.extra(decorators);
    if (indices.len == 0) return fallback;
    return tree.span(indices[indices.len - 1]).end;
}

fn pattern_type_annotation(tree: *const parser.ast.Tree, index: NodeIndex) NodeIndex {
    return switch (tree.data(index)) {
        .binding_identifier => |pattern| pattern.type_annotation,
        .assignment_pattern => |pattern| pattern.type_annotation,
        .binding_rest_element => |pattern| pattern.type_annotation,
        .array_pattern => |pattern| pattern.type_annotation,
        .object_pattern => |pattern| pattern.type_annotation,
        else => .null,
    };
}

fn next_import_specifier(
    tree: *const parser.ast.Tree,
    specifiers: []const NodeIndex,
    start: usize,
) NodeIndex {
    for (specifiers[start..]) |index| {
        if (tree.data(index) == .import_specifier) return index;
    }
    return .null;
}

fn is_whole_type_declaration(tree: *const parser.ast.Tree, index: NodeIndex) bool {
    if (index == .null) return false;

    return switch (tree.data(index)) {
        .ts_type_alias_declaration,
        .ts_interface_declaration,
        .ts_namespace_export_declaration,
        .ts_global_declaration,
        => true,
        .function => |function| function.type == .ts_declare_function,
        .class => |class| class.declare,
        .variable_declaration => |declaration| declaration.declare,
        .ts_enum_declaration => |declaration| declaration.declare,
        .ts_module_declaration => |declaration| namespace_semantics.is_type_only_module(tree, declaration),
        .ts_import_equals_declaration => |declaration| declaration.import_kind == .type,
        else => false,
    };
}

test "eraser uses native spans for type syntax" {
    const allocator = std.testing.allocator;
    const source = "function id<T>(value: T): T { return id<string>(value); }\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "function id   (value   )    { return id        (value); }\n",
        output,
    );
}

test "eraser removes whole type-only declarations" {
    const allocator = std.testing.allocator;
    const source =
        "interface Box<T> { value: T }\n" ++
        "type Name = string;\n" ++
        "declare function load(): Name;\n" ++
        "const value: Name = load();\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "                             \n" ++
            "                   \n" ++
            "                              \n" ++
            "const value       = load();\n",
        output,
    );
}

test "whole-node erasure preserves an ASI statement boundary" {
    const allocator = std.testing.allocator;
    const source =
        "run()\n" ++
        "interface First {}\n" ++
        "type Second = string\n" ++
        "(next)();\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expect(std.mem.indexOf(u8, output, "run()\n;") != null);

    var reparsed = try parser.parse(allocator, output, .{
        .lang = .js,
        .comments = .none,
        .tokens = false,
    });
    defer reparsed.deinit();
    try std.testing.expect(!reparsed.hasErrors());
}

test "type-only namespaces erase while runtime namespaces remain for lowering" {
    const allocator = std.testing.allocator;
    const source =
        "namespace Types { interface Item {} type Name = string }\n" ++
        "namespace Nested { namespace Inner { interface Item {} } }\n" ++
        "namespace Runtime { export const value = 1; interface Item {} }\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expect(std.mem.indexOf(u8, output, "Types") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Nested") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Inner") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "namespace Runtime") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "export const value = 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "interface Item") == null);
}

test "eraser removes native class TypeScript syntax and ambient declarations" {
    const allocator = std.testing.allocator;
    const source =
        "abstract class Box<T> extends Base<T> implements ReadonlyBox<T>, Named {\n" ++
        "  public readonly value!: T;\n" ++
        "  protected override method?(arg: T): void { return; }\n" ++
        "  declare cached: T;\n" ++
        "  abstract missing(): void;\n" ++
        "  [key: string]: unknown;\n" ++
        "}\n" ++
        "declare class Ambient {}\n" ++
        "declare const ambient: number;\n" ++
        "declare enum AmbientEnum { A }\n" ++
        "declare namespace Types { interface X {} }\n" ++
        "import type Alias = Types.X;\n" ++
        "export declare class Exported {}\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);

    try std.testing.expect(std.mem.indexOf(u8, output, "class Box") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "value") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "method") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "abstract") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "implements") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "readonly") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "protected") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "override") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "declare") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Ambient") == null);
    try std.testing.expectEqual(@import("unicode.zig").utf16_width(source), @import("unicode.zig").utf16_width(output));
}

test "eraser removes parameter and binding-only syntax" {
    const allocator = std.testing.allocator;
    const source =
        "function f(this: void, value?: number): number { return value!; }\n" ++
        "function only(this: void) {}\n" ++
        "function trailing(this: void,) {}\n" ++
        "let result!: number;\n" ++
        "class C { constructor(public readonly x: number, protected override y: string) {} }\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);

    try std.testing.expect(std.mem.indexOf(u8, output, "function f(") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "value") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "function only(") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "constructor(") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "this") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "public") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "readonly") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "protected") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "override") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "?") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "!") == null);
    try std.testing.expectEqual(
        @import("unicode.zig").utf16_width(source),
        @import("unicode.zig").utf16_width(output),
    );
}

test "eraser removes type-only import and export list items" {
    const allocator = std.testing.allocator;
    const source =
        "import type Default from \"types\";\n" ++
        "import { type A, B, /* lead */ type C } from \"values\";\n" ++
        "export { type A, B, type C };\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "                                 \n" ++
            "import {         B, /* lead */        } from \"values\";\n" ++
            "export {         B,        };\n",
        output,
    );
}

test "eraser removes expression-level TypeScript wrappers" {
    const allocator = std.testing.allocator;
    const source =
        "const a = value as string;\n" ++
        "const b = value satisfies Constraint;\n" ++
        "const c = value!;\n" ++
        "const d = <number>value;\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "const a = value          ;\n" ++
            "const b = value                     ;\n" ++
            "const c = value ;\n" ++
            "const d =         value;\n",
        output,
    );
}

test "suffix assertions preserve ASI boundaries" {
    const allocator = std.testing.allocator;
    const source = "value as string\n(next)();\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings("value;         \n(next)();\n", output);
}

test "suffix assertions retain grouping on the left of exponentiation" {
    const allocator = std.testing.allocator;
    const source =
        "const a = -value as number ** 2;\n" ++
        "const b = -value as 𝒳 ** 2;\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "const a =(-value         ) ** 2;\n" ++
            "const b =(-value    )  ** 2;\n",
        output,
    );
}

test "multiline arrow corrections remain valid JavaScript" {
    const allocator = std.testing.allocator;
    const source =
        "const generic = async <T>\n" ++
        "(value: T): T => value;\n" ++
        "function make() { return <T>\n" ++
        "(value: T) => value; }\n" ++
        "const typed = (value: number):\n" ++
        "    number | string => value;\n";
    var tree = try parser.parse(allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(source, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqual(
        @import("unicode.zig").utf16_width(source),
        @import("unicode.zig").utf16_width(output),
    );

    var reparsed = try parser.parse(allocator, output, .{
        .lang = .js,
        .comments = .none,
        .tokens = false,
    });
    defer reparsed.deinit();
    try std.testing.expect(!reparsed.hasErrors());
}

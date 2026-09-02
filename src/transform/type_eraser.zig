const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const namespace_semantics = @import("namespace_semantics.zig");
const runtime_transformer = @import("runtime_transformer.zig");
const source_layout = @import("source_layout.zig");
const token_cursor = @import("token_cursor.zig");
const unicode = @import("unicode.zig");

const Action = parser.traverser.Action;
const Allocator = std.mem.Allocator;
const Ctx = parser.traverser.basic.Ctx;
const NodeIndex = parser.ast.NodeIndex;

const StatementListCursor = struct {
    parent: NodeIndex = .null,
    next_position: usize = 0,
    previous: NodeIndex = .null,
};

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
    statement_cursors: [256]StatementListCursor = @splat(.{}),

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
        try self.erase_postfix_type_assertion(expression.expression, index, ctx);
        return .proceed;
    }

    pub fn enter_ts_satisfies_expression(
        self: *Visitor,
        expression: parser.ast.TSSatisfiesExpression,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!Action {
        try self.erase_postfix_type_assertion(expression.expression, index, ctx);
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

        const inner = declaration.declaration;
        if (self.runtime != null and inner != .null) {
            if (namespace_semantics.is_supported_runtime_export_declaration(ctx.tree, inner) and
                is_inside_runtime_namespace(ctx))
            {
                const wrapper_span = ctx.tree.span(index);
                const declaration_span = ctx.tree.span(inner);
                if (self.tokens.find_forward(wrapper_span.start, declaration_span.start, "export")) |token| {
                    try self.edits.add_blank(token.span.start, token.span.end);
                }
            } else {
                const enum_declaration = switch (ctx.tree.data(inner)) {
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
                            const enum_span = ctx.tree.span(inner);
                            if (self.tokens.find_forward(wrapper_span.start, enum_span.start, "export")) |token| {
                                try self.edits.add_blank(token.span.start, token.span.end);
                            }
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
        if (!self.needs_semicolon_before_erasure(index, ctx)) return;

        try self.add_statement_separator(span);
    }

    fn needs_semicolon_before_erasure(
        self: *Visitor,
        index: NodeIndex,
        ctx: *Ctx,
    ) bool {
        const parent_index = ctx.path.parent() orelse return false;
        const parent = ctx.tree.data(parent_index);
        if (is_required_statement_slot(parent, index)) return true;

        const statements = statement_list(ctx.tree, parent) orelse return false;
        const parent_depth = ctx.path.depth() - 1;
        if (parent_depth >= self.statement_cursors.len) {
            return needs_semicolon_before_erasure_slow(index, ctx, self.tokens.source);
        }

        const cursor = &self.statement_cursors[parent_depth];
        if (cursor.parent != parent_index) cursor.* = .{ .parent = parent_index };

        var previous = cursor.previous;
        var position = cursor.next_position;
        while (position < statements.len) : (position += 1) {
            const statement = statements[position];
            if (statement == .null) continue;
            if (statement != index) {
                previous = statement;
                continue;
            }

            cursor.next_position = position + 1;
            cursor.previous = statement;
            if (previous != .null) {
                if (is_erasable_statement(ctx.tree, previous)) return false;
                const previous_span = ctx.tree.span(previous);
                return previous_span.end > 0 and
                    self.tokens.source[previous_span.end - 1] != ';';
            }
            return switch (parent) {
                .program, .function_body, .ts_module_block => true,
                else => false,
            };
        }
        return needs_semicolon_before_erasure_slow(index, ctx, self.tokens.source);
    }

    fn add_statement_separator(
        self: *Visitor,
        span: parser.ast.Span,
    ) Allocator.Error!void {
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

        var first_modifier_start: ?u32 = null;
        if (property.readonly) {
            if (try self.erase_keyword(search_start, key_span.start, "readonly")) |start| {
                first_modifier_start = earliest_position(first_modifier_start, start);
            }
        }
        if (property.override) {
            if (try self.erase_keyword(search_start, key_span.start, "override")) |start| {
                first_modifier_start = earliest_position(first_modifier_start, start);
            }
        }
        if (property.accessibility != .none) {
            if (try self.erase_keyword(
                search_start,
                key_span.start,
                property.accessibility.toString(),
            )) |start| {
                first_modifier_start = earliest_position(first_modifier_start, start);
            }
        }

        const key_token = self.tokens.first_in_range(key_span.start, key_span.end);
        const hazardous_key = property.computed or self.is_hazardous_class_key(key_token);
        try self.separate_hazardous_class_element(
            index,
            property_span,
            first_modifier_start,
            hazardous_key,
            property.static or property.accessor or property.decorators.len > 0,
            ctx,
        );

        var marker_end = property_span.end;
        if (property.type_annotation != .null) {
            marker_end = @min(marker_end, ctx.tree.span(property.type_annotation).start);
        }
        if (property.value != .null) {
            marker_end = @min(marker_end, ctx.tree.span(property.value).start);
        }
        const optional_start = if (property.optional)
            try self.erase_punctuation(key_span.end, marker_end, "?")
        else
            null;
        const definite_start = if (property.definite)
            try self.erase_punctuation(key_span.end, marker_end, "!")
        else
            null;
        const separator_start = if (property.type_annotation != .null)
            ctx.tree.span(property.type_annotation).start
        else
            optional_start orelse definite_start;
        try self.preserve_keyword_named_class_field(
            key_span,
            separator_start,
            property.value != .null,
        );
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
        var first_modifier_start: ?u32 = null;
        if (method.override) {
            if (try self.erase_keyword(search_start, key_span.start, "override")) |start| {
                first_modifier_start = earliest_position(first_modifier_start, start);
            }
        }
        if (method.accessibility != .none) {
            if (try self.erase_keyword(
                search_start,
                key_span.start,
                method.accessibility.toString(),
            )) |start| {
                first_modifier_start = earliest_position(first_modifier_start, start);
            }
        }
        const function = switch (ctx.tree.data(method.value)) {
            .function => |value| value,
            else => unreachable,
        };
        const key_token = self.tokens.first_in_range(key_span.start, key_span.end);
        const hazardous_key = method.computed or
            function.generator or
            self.is_hazardous_class_key(key_token);
        try self.separate_hazardous_class_element(
            index,
            method_span,
            first_modifier_start,
            hazardous_key,
            method.static or method.decorators.len > 0,
            ctx,
        );
        if (method.optional) {
            const function_start = ctx.tree.span(method.value).start;
            _ = try self.erase_punctuation(key_span.end, function_start, "?");
        }
    }

    fn separate_hazardous_class_element(
        self: *Visitor,
        index: NodeIndex,
        member_span: parser.ast.Span,
        first_erased_modifier: ?u32,
        hazardous_key: bool,
        protected_by_javascript_syntax: bool,
        ctx: *Ctx,
    ) Allocator.Error!void {
        if (!hazardous_key or protected_by_javascript_syntax) return;
        if (first_erased_modifier != member_span.start) return;
        if (!self.needs_semicolon_before_erasure(index, ctx)) return;

        try self.edits.add_substitution(member_span.start, .semicolon);
    }

    fn is_hazardous_class_key(
        self: *const Visitor,
        token: ?parser.ast.Token,
    ) bool {
        const key = token orelse return false;
        const text = self.tokens.text(key);
        return std.mem.eql(u8, text, "in") or std.mem.eql(u8, text, "instanceof");
    }

    fn is_contextual_class_field_key(
        self: *const Visitor,
        token: ?parser.ast.Token,
    ) bool {
        const key = token orelse return false;
        const text = self.tokens.text(key);
        return std.mem.eql(u8, text, "get") or
            std.mem.eql(u8, text, "set") or
            std.mem.eql(u8, text, "static");
    }

    fn preserve_keyword_named_class_field(
        self: *Visitor,
        key_span: parser.ast.Span,
        separator_start: ?u32,
        has_value: bool,
    ) Allocator.Error!void {
        if (has_value) return;
        const separator = separator_start orelse return;

        const key = self.tokens.first_in_range(key_span.start, key_span.end);
        if (!self.is_contextual_class_field_key(key)) return;

        try self.edits.add_substitution(separator, .semicolon);
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
    ) Allocator.Error!?u32 {
        const token = self.tokens.find_forward(start, end, punctuation) orelse return null;
        try self.edits.add_blank(token.span.start, token.span.end);
        return token.span.start;
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
    }

    fn erase_postfix_type_assertion(
        self: *Visitor,
        expression_index: NodeIndex,
        wrapper_index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        try self.erase_suffix_expression(expression_index, wrapper_index, ctx);

        const wrapper_span = ctx.tree.span(wrapper_index);
        if (!self.ends_containing_statement(wrapper_span, ctx)) return;

        const source = self.tokens.source;
        if (wrapper_span.end >= source.len) return;

        const following = source[wrapper_span.end];
        if (following > ' ' and following < 0x80 and following != '/') return;

        const next = self.tokens.at_or_after(wrapper_span.end) orelse return;
        if (!source_layout.contains_line_terminator(
            source[wrapper_span.end..next.span.start],
        )) return;

        const next_text = self.tokens.text(next);
        const is_hazardous = std.mem.eql(u8, next_text, "(") or
            std.mem.eql(u8, next_text, "[") or
            (next.type == .template and next_text.len > 0 and next_text[0] == '`');
        if (!is_hazardous) return;

        const expression_span = ctx.tree.span(expression_index);
        try self.edits.add_substitution(expression_span.end, .semicolon);
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

fn needs_semicolon_before_erasure_slow(
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
        if (previous == .null) continue;
        if (is_erasable_statement(ctx.tree, previous)) return false;

        const previous_span = ctx.tree.span(previous);
        if (previous_span.end == 0) return false;
        return source[previous_span.end - 1] != ';';
    }
    return switch (parent) {
        .program, .function_body, .ts_module_block => true,
        else => false,
    };
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

fn earliest_position(current: ?u32, candidate: u32) u32 {
    return if (current) |position| @min(position, candidate) else candidate;
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
        \\interface Box<T> { value: T }
        \\type Name = string;
        \\declare function load(): Name;
        \\const value: Name = load();
        \\
    ;
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
        ";                            \n" ++
            "                   \n" ++
            "                              \n" ++
            "const value       = load();\n",
        output,
    );
}

test "whole-node erasure preserves an ASI statement boundary" {
    const allocator = std.testing.allocator;
    const source =
        \\run()
        \\interface First {}
        \\type Second = string
        \\(next)();
        \\
    ;
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
        \\namespace Types { interface Item {} type Name = string }
        \\namespace Nested { namespace Inner { interface Item {} } }
        \\namespace Runtime { export const value = 1; interface Item {} }
        \\
    ;
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
        \\abstract class Box<T> extends Base<T> implements ReadonlyBox<T>, Named {
        \\  public readonly value!: T;
        \\  protected override method?(arg: T): void { return; }
        \\  declare cached: T;
        \\  abstract missing(): void;
        \\  [key: string]: unknown;
        \\}
        \\declare class Ambient {}
        \\declare const ambient: number;
        \\declare enum AmbientEnum { A }
        \\declare namespace Types { interface X {} }
        \\import type Alias = Types.X;
        \\export declare class Exported {}
        \\
    ;
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
    try std.testing.expectEqual(unicode.utf16_width(source), unicode.utf16_width(output));
}

test "eraser removes parameter and binding-only syntax" {
    const allocator = std.testing.allocator;
    const source =
        \\function f(this: void, value?: number): number { return value!; }
        \\function only(this: void) {}
        \\function trailing(this: void,) {}
        \\let result!: number;
        \\class C { constructor(public readonly x: number, protected override y: string) {} }
        \\
    ;
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
        unicode.utf16_width(source),
        unicode.utf16_width(output),
    );
}

test "eraser removes type-only import and export list items" {
    const allocator = std.testing.allocator;
    const source =
        \\import type Default from "types";
        \\import { type A, B, /* lead */ type C } from "values";
        \\export { type A, B, type C };
        \\
    ;
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
        ";                                \n" ++
            "import {         B, /* lead */        } from \"values\";\n" ++
            "export {         B,        };\n",
        output,
    );
}

test "eraser removes expression-level TypeScript wrappers" {
    const allocator = std.testing.allocator;
    const source =
        \\const a = value as string;
        \\const b = value satisfies Constraint;
        \\const c = value!;
        \\const d = <number>value;
        \\
    ;
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
        \\const a = -value as number ** 2;
        \\const b = -value as 𝒳 ** 2;
        \\
    ;
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
        \\const generic = async <T>
        \\(value: T): T => value;
        \\function make() { return <T>
        \\(value: T) => value; }
        \\const typed = (value: number):
        \\    number | string => value;
        \\
    ;
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
        unicode.utf16_width(source),
        unicode.utf16_width(output),
    );

    var reparsed = try parser.parse(allocator, output, .{
        .lang = .js,
        .comments = .none,
        .tokens = false,
    });
    defer reparsed.deinit();
    try std.testing.expect(!reparsed.hasErrors());
}

fn expect_strip(
    lang: parser.ast.Lang,
    original: []const u8,
    expected: []const u8,
) !void {
    const allocator = std.testing.allocator;
    var tree = try parser.parse(allocator, original, .{
        .lang = lang,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, original);
    defer edits.deinit();
    try erase(&tree, token_cursor.TokenCursor.init(original, tree.tokens), &edits);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(expected, output);
    try std.testing.expectEqual(
        unicode.utf16_width(original),
        unicode.utf16_width(output),
    );
}

test "strip: annotations.variable_type_annotation" {
    try expect_strip(
        .ts,
        "let value: number = 1;",
        "let value         = 1;",
    );
}

test "strip: annotations.function_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "function f(value: number) {}",
        "function f(value        ) {}",
    );
}

test "strip: annotations.function_return_type_annotation" {
    try expect_strip(
        .ts,
        "function f(): number {}",
        "function f()         {}",
    );
}

test "strip: annotations.function_expression_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "const f = function(value: Type) {};",
        "const f = function(value      ) {};",
    );
}

test "strip: annotations.function_expression_return_type_annotation" {
    try expect_strip(
        .ts,
        "const f = function(): Type {};",
        "const f = function()       {};",
    );
}

test "strip: annotations.arrow_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "const f = (value: Type) => value;",
        "const f = (value      ) => value;",
    );
}

test "strip: annotations.arrow_return_type_annotation" {
    try expect_strip(
        .ts,
        "const f = (): Type => value;",
        "const f = ()       => value;",
    );
}

test "strip: annotations.constructor_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "class C { constructor(value: Type) {} }",
        "class C { constructor(value      ) {} }",
    );
}

test "strip: annotations.default_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "function f(value: Type = initial) {}",
        "function f(value       = initial) {}",
    );
}

test "strip: annotations.rest_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "function f(...values: Type[]) {}",
        "function f(...values        ) {}",
    );
}

test "strip: annotations.object_binding_type_annotation" {
    try expect_strip(
        .ts,
        "const { value }: Shape = input;",
        "const { value }        = input;",
    );
}

test "strip: annotations.array_binding_type_annotation" {
    try expect_strip(
        .ts,
        "const [value]: Items = input;",
        "const [value]        = input;",
    );
}

test "strip: annotations.object_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "function f({ value }: Shape) {}",
        "function f({ value }       ) {}",
    );
}

test "strip: annotations.catch_binding_type_annotation" {
    try expect_strip(
        .ts,
        "try {} catch (error: unknown) {}",
        "try {} catch (error         ) {}",
    );
}

test "strip: annotations.object_method_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "const object = { method(value: number) {} };",
        "const object = { method(value        ) {} };",
    );
}

test "strip: annotations.object_method_return_type_annotation" {
    try expect_strip(
        .ts,
        "const object = { method(): number { return 1; } };",
        "const object = { method()         { return 1; } };",
    );
}

test "strip: annotations.object_getter_return_type_annotation" {
    try expect_strip(
        .ts,
        "const object = { get value(): number { return 1; } };",
        "const object = { get value()         { return 1; } };",
    );
}

test "strip: annotations.object_setter_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "const object = { set value(input: number) {} };",
        "const object = { set value(input        ) {} };",
    );
}

test "strip: annotations.class_method_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "class C { method(value: Type) {} }",
        "class C { method(value      ) {} }",
    );
}

test "strip: annotations.class_method_return_type_annotation" {
    try expect_strip(
        .ts,
        "class C { method(): Type {} }",
        "class C { method()       {} }",
    );
}

test "strip: annotations.class_getter_return_type_annotation" {
    try expect_strip(
        .ts,
        "class C { get value(): Type { return input; } }",
        "class C { get value()       { return input; } }",
    );
}

test "strip: annotations.class_setter_parameter_type_annotation" {
    try expect_strip(
        .ts,
        "class C { set value(input: Type) {} }",
        "class C { set value(input      ) {} }",
    );
}

test "strip: annotations.class_field_type_annotation" {
    try expect_strip(
        .ts,
        "class C { value: number = 1; }",
        "class C { value         = 1; }",
    );
}

test "strip: annotations.auto_accessor_type_annotation" {
    try expect_strip(
        .ts,
        "class C { accessor value: Type; }",
        "class C { accessor value      ; }",
    );
}

test "strip: annotations.nested_generic_type_annotation" {
    try expect_strip(
        .ts,
        "let value: Box<Item> = input;",
        "let value            = input;",
    );
}

test "strip: annotations.multiline_arrow_return_type" {
    try expect_strip(
        .ts,
        "const f = ():\nnumber => 1;",
        "const f = (  \n     ) => 1;",
    );
}

test "strip: annotations.astral_string_literal_return_type_preserves_utf16_width" {
    try expect_strip(
        .ts,
        "function f(): '💥' {}",
        "function f()       {}",
    );
}

test "strip: asi.unterminated_expression_before_type_alias" {
    try expect_strip(
        .ts,
        "foo\ntype T = string;\n(1);",
        "foo\n;               \n(1);",
    );
}

test "strip: asi.terminated_expression_before_type_alias" {
    try expect_strip(
        .ts,
        "foo;\ntype T = string;\n(1);",
        "foo;\n                \n(1);",
    );
}

test "strip: asi.type_alias_as_if_statement_body" {
    try expect_strip(
        .ts,
        "if (ok)\n    type T = string;\nrun();",
        "if (ok)\n    ;               \nrun();",
    );
}

test "strip: asi.type_alias_as_else_statement_body" {
    try expect_strip(
        .ts,
        "if (ok) run();\nelse type T = string;\nafter();",
        "if (ok) run();\nelse ;               \nafter();",
    );
}

test "strip: asi.interface_as_while_statement_body" {
    try expect_strip(
        .ts,
        "while (ok)\n    interface I {}\nafter();",
        "while (ok)\n    ;             \nafter();",
    );
}

test "strip: asi.type_alias_as_for_statement_body" {
    try expect_strip(
        .ts,
        "for (;;)\n    type T = string;\nafter();",
        "for (;;)\n    ;               \nafter();",
    );
}

test "strip: asi.interface_as_labeled_statement_body" {
    try expect_strip(
        .ts,
        "label: interface I {}\nafter();",
        "label: ;             \nafter();",
    );
}

test "strip: asi.interface_as_do_while_statement_body" {
    try expect_strip(
        .ts,
        "do\n    interface I {}\nwhile (ok);",
        "do\n    ;             \nwhile (ok);",
    );
}

test "strip: asi.suffix_assertion_before_parenthesized_statement" {
    try expect_strip(
        .ts,
        "value as string\n(next)();",
        "value;         \n(next)();",
    );
}

test "strip: asi.suffix_assertion_with_trailing_comment_before_parenthesized_statement" {
    try expect_strip(
        .ts,
        "value as Type/* comment */\n(next)();",
        "value;       /* comment */\n(next)();",
    );
}

test "strip: asi.satisfies_assertion_before_computed_statement" {
    try expect_strip(
        .ts,
        "value satisfies Type\n[next]();",
        "value;              \n[next]();",
    );
}

test "strip: asi.suffix_assertion_before_safe_statement_needs_no_separator" {
    try expect_strip(
        .ts,
        "value as Type\nnext();",
        "value        \nnext();",
    );
}

test "strip: asi.suffix_assertion_before_template_statement" {
    try expect_strip(
        .ts,
        "value as Type\n`next`;",
        "value;       \n`next`;",
    );
}

test "strip: asi.consecutive_type_declarations_terminate_directive_prologue" {
    try expect_strip(
        .ts,
        "interface A {}\ntype B = string;\n'use strict';",
        ";             \n                \n'use strict';",
    );
}

test "strip: asi.first_erased_script_statement_terminates_directive_prologue" {
    try expect_strip(
        .ts,
        "type T = string;\n'use strict';",
        ";               \n'use strict';",
    );
}

test "strip: asi.first_erased_module_statement_terminates_directive_prologue" {
    try expect_strip(
        .ts,
        "type T = string;\n'use strict';\nexport {};",
        ";               \n'use strict';\nexport {};",
    );
}

test "strip: asi.first_erased_function_statement_terminates_directive_prologue" {
    try expect_strip(
        .ts,
        "function f() {\ntype T = string;\n'use strict';\n}",
        "function f() {\n;               \n'use strict';\n}",
    );
}

test "strip: asi.erased_class_modifier_separates_computed_field" {
    try expect_strip(
        .ts,
        "class C { first = 1\npublic ['second'] = 2; }",
        "class C { first = 1\n;      ['second'] = 2; }",
    );
}

test "strip: asi.suffix_assertion_separates_computed_class_member" {
    try expect_strip(
        .ts,
        "class C { value = input as Type\n['next']() {} }",
        "class C { value = input;       \n['next']() {} }",
    );
}

test "strip: asi.suffix_assertion_before_binary_continuation_stays_connected" {
    try expect_strip(
        .ts,
        "value as Type\n+ next;",
        "value        \n+ next;",
    );
}

test "strip: asi.suffix_assertion_before_member_continuation_stays_connected" {
    try expect_strip(
        .ts,
        "const value = input!\n[0];",
        "const value = input \n[0];",
    );
}

test "strip: asi.parenthesized_suffix_assertion_before_call_continuation_stays_connected" {
    try expect_strip(
        .ts,
        "const value = (input as Fn)\n(0);",
        "const value = (input      )\n(0);",
    );
}

test "strip: bindings.optional_parameter_marker" {
    try expect_strip(
        .ts,
        "function f(value?: number) {}",
        "function f(value         ) {}",
    );
}

test "strip: bindings.optional_parameter_marker_after_comment" {
    try expect_strip(
        .ts,
        "const f = (value/** doc */?: Type) => value;",
        "const f = (value/** doc */       ) => value;",
    );
}

test "strip: bindings.optional_destructured_parameter_marker" {
    try expect_strip(
        .ts,
        "function f({ value }?: Shape) {}",
        "function f({ value }        ) {}",
    );
}

test "strip: bindings.optional_array_parameter_marker" {
    try expect_strip(
        .ts,
        "function f([value]?: Items) {}",
        "function f([value]        ) {}",
    );
}

test "strip: bindings.variable_definite_assignment_marker" {
    try expect_strip(
        .ts,
        "let value!: number;",
        "let value         ;",
    );
}

test "strip: bindings.explicit_this_parameter_only" {
    try expect_strip(
        .ts,
        "function f(this: void) {}",
        "function f(          ) {}",
    );
}

test "strip: bindings.explicit_this_parameter_before_value_parameter" {
    try expect_strip(
        .ts,
        "function f(this: void, value: number) {}",
        "function f(            value        ) {}",
    );
}

test "strip: bindings.explicit_this_parameter_with_trailing_comma" {
    try expect_strip(
        .ts,
        "function f(this: void,) {}",
        "function f(           ) {}",
    );
}

test "strip: bindings.explicit_this_parameter_before_rest_parameter" {
    try expect_strip(
        .ts,
        "function f(this: void, ...values: Type[]) {}",
        "function f(            ...values        ) {}",
    );
}

test "strip: classes.abstract_class_modifier" {
    try expect_strip(
        .ts,
        "abstract class C {}",
        "         class C {}",
    );
}

test "strip: classes.decorated_abstract_class_modifier" {
    try expect_strip(
        .ts,
        "@decorators.abstract abstract class C {}",
        "@decorators.abstract          class C {}",
    );
}

test "strip: classes.public_field_modifier" {
    try expect_strip(
        .ts,
        "class C { public value = 1; }",
        "class C {        value = 1; }",
    );
}

test "strip: classes.readonly_field_modifier" {
    try expect_strip(
        .ts,
        "class C { readonly value = 1; }",
        "class C {          value = 1; }",
    );
}

test "strip: classes.override_method_modifier" {
    try expect_strip(
        .ts,
        "class C { override method() {} }",
        "class C {          method() {} }",
    );
}

test "strip: classes.private_field_modifier" {
    try expect_strip(
        .ts,
        "class C { private value = 1; }",
        "class C {         value = 1; }",
    );
}

test "strip: classes.protected_method_modifier" {
    try expect_strip(
        .ts,
        "class C { protected method() {} }",
        "class C {           method() {} }",
    );
}

test "strip: classes.override_field_modifier" {
    try expect_strip(
        .ts,
        "class C { override value = 1; }",
        "class C {          value = 1; }",
    );
}

test "strip: classes.class_extends_type_arguments" {
    try expect_strip(
        .ts,
        "class C extends Base<Type> {}",
        "class C extends Base       {}",
    );
}

test "strip: classes.class_implements_clause" {
    try expect_strip(
        .ts,
        "class C implements A, B {}",
        "class C                 {}",
    );
}

test "strip: classes.generic_class_implements_clause" {
    try expect_strip(
        .ts,
        "class C<T> implements A<T> {}",
        "class C                    {}",
    );
}

test "strip: classes.optional_field_marker" {
    try expect_strip(
        .ts,
        "class C { value?: number; }",
        "class C { value         ; }",
    );
}

test "strip: classes.optional_get_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { get?\nnext() {} }",
        "class C { get;\nnext() {} }",
    );
}

test "strip: classes.optional_set_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { set?\nnext() {} }",
        "class C { set;\nnext() {} }",
    );
}

test "strip: classes.optional_static_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { static?\nnext() {} }",
        "class C { static;\nnext() {} }",
    );
}

test "strip: classes.definite_field_marker" {
    try expect_strip(
        .ts,
        "class C { value!: number; }",
        "class C { value         ; }",
    );
}

test "strip: classes.optional_method_marker" {
    try expect_strip(
        .ts,
        "class C { method?(): void {} }",
        "class C { method ()       {} }",
    );
}

test "strip: classes.optional_generic_method" {
    try expect_strip(
        .ts,
        "class C { method?<T>(): void {} }",
        "class C { method    ()       {} }",
    );
}

test "strip: classes.abstract_property_declaration" {
    try expect_strip(
        .ts,
        "class C { abstract value: number; next = 1; }",
        "class C {                         next = 1; }",
    );
}

test "strip: classes.declared_property_declaration" {
    try expect_strip(
        .ts,
        "class C { declare value: Type; next = 1; }",
        "class C {                      next = 1; }",
    );
}

test "strip: classes.abstract_method_declaration" {
    try expect_strip(
        .ts,
        "class C { abstract method(): Type; next() {} }",
        "class C {                          next() {} }",
    );
}

test "strip: classes.method_overload_signature" {
    try expect_strip(
        .ts,
        "class C { method(value: string): string; method(value: string) {} }",
        "class C {                                method(value        ) {} }",
    );
}

test "strip: classes.class_index_signature" {
    try expect_strip(
        .ts,
        "class C { [key: string]: number; next = 1; }",
        "class C {                        next = 1; }",
    );
}

test "strip: classes.erased_modifier_before_static_computed_method_needs_no_separator" {
    try expect_strip(
        .ts,
        "class C { first = 1\npublic static ['second']() {} }",
        "class C { first = 1\n       static ['second']() {} }",
    );
}

test "strip: classes.erased_modifier_separates_generator_method" {
    try expect_strip(
        .ts,
        "class C { first = 1\npublic *next() {} }",
        "class C { first = 1\n;      *next() {} }",
    );
}

test "strip: classes.erased_modifier_separates_in_field" {
    try expect_strip(
        .ts,
        "class C { first = 1\npublic in; }",
        "class C { first = 1\n;      in; }",
    );
}

test "strip: classes.get_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { get: Type\nnext() {} }",
        "class C { get;     \nnext() {} }",
    );
}

test "strip: classes.set_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { set: Type\nnext() {} }",
        "class C { set;     \nnext() {} }",
    );
}

test "strip: classes.static_named_field_keeps_field_boundary" {
    try expect_strip(
        .ts,
        "class C { static: Type\nnext() {} }",
        "class C { static;     \nnext() {} }",
    );
}

test "strip: classes.decorator_separates_computed_method_after_modifier_erasure" {
    try expect_strip(
        .ts,
        "class C { first = 1\n@dec public ['second']() {} }",
        "class C { first = 1\n@dec        ['second']() {} }",
    );
}

test "strip: classes.decorator_named_readonly_does_not_hide_field_modifier" {
    try expect_strip(
        .ts,
        "class C { @readonly readonly value = 1; }",
        "class C { @readonly          value = 1; }",
    );
}

test "strip: classes.decorator_named_override_does_not_hide_method_modifier" {
    try expect_strip(
        .ts,
        "class C { @override override method() {} }",
        "class C { @override          method() {} }",
    );
}

test "strip: classes.decorator_named_public_does_not_hide_accessibility_modifier" {
    try expect_strip(
        .ts,
        "class C { @public public value = 1; }",
        "class C { @public        value = 1; }",
    );
}

test "strip: declarations.type_alias_declaration" {
    try expect_strip(
        .ts,
        "type T = string;\nrun();",
        ";               \nrun();",
    );
}

test "strip: declarations.interface_declaration" {
    try expect_strip(
        .ts,
        "interface I {}\nrun();",
        ";             \nrun();",
    );
}

test "strip: declarations.exported_interface_declaration" {
    try expect_strip(
        .ts,
        "export interface I {}\nrun();",
        ";                    \nrun();",
    );
}

test "strip: declarations.namespace_export_declaration" {
    try expect_strip(
        .ts,
        "export as namespace Lib;\nrun();",
        ";                       \nrun();",
    );
}

test "strip: declarations.ambient_variable_declaration" {
    try expect_strip(
        .ts,
        "declare const value: number;\nrun();",
        ";                           \nrun();",
    );
}

test "strip: declarations.ambient_class_declaration" {
    try expect_strip(
        .ts,
        "declare class C {}\nrun();",
        ";                 \nrun();",
    );
}

test "strip: declarations.exported_ambient_class_declaration" {
    try expect_strip(
        .ts,
        "export declare class C {}\nrun();",
        ";                        \nrun();",
    );
}

test "strip: declarations.ambient_function_declaration" {
    try expect_strip(
        .ts,
        "declare function f(): void;\nrun();",
        ";                          \nrun();",
    );
}

test "strip: declarations.exported_ambient_function_declaration" {
    try expect_strip(
        .ts,
        "export declare function f(): void;\nrun();",
        ";                                 \nrun();",
    );
}

test "strip: declarations.exported_function_overload_signature" {
    try expect_strip(
        .ts,
        "export function f(): void;\nexport function f() {}",
        ";                         \nexport function f() {}",
    );
}

test "strip: declarations.function_overload_signature" {
    try expect_strip(
        .ts,
        "function f(): void;\nfunction f() {}",
        ";                  \nfunction f() {}",
    );
}

test "strip: declarations.ambient_enum_declaration" {
    try expect_strip(
        .ts,
        "declare enum E {}\nrun();",
        ";                \nrun();",
    );
}

test "strip: declarations.exported_ambient_enum_declaration" {
    try expect_strip(
        .ts,
        "export declare enum E {}\nrun();",
        ";                       \nrun();",
    );
}

test "strip: declarations.ambient_namespace_declaration" {
    try expect_strip(
        .ts,
        "declare namespace N { const value: number; }\nrun();",
        ";                                           \nrun();",
    );
}

test "strip: declarations.exported_ambient_namespace_declaration" {
    try expect_strip(
        .ts,
        "export declare namespace N {}\nrun();",
        ";                            \nrun();",
    );
}

test "strip: declarations.exported_ambient_variable_declaration" {
    try expect_strip(
        .ts,
        "export declare const value: number;\nrun();",
        ";                                  \nrun();",
    );
}

test "strip: declarations.type_only_namespace_declaration" {
    try expect_strip(
        .ts,
        "namespace N { export type T = string; }\nrun();",
        ";                                      \nrun();",
    );
}

test "strip: declarations.qualified_type_only_namespace_declaration" {
    try expect_strip(
        .ts,
        "namespace A.B { type T = string; }\nrun();",
        ";                                 \nrun();",
    );
}

test "strip: declarations.empty_namespace_declaration" {
    try expect_strip(
        .ts,
        "namespace N {}\nrun();",
        ";             \nrun();",
    );
}

test "strip: declarations.ambient_external_module_declaration" {
    try expect_strip(
        .ts,
        "declare module 'pkg' { const value: number; }\nrun();",
        ";                                            \nrun();",
    );
}

test "strip: declarations.global_augmentation_declaration" {
    try expect_strip(
        .ts,
        "declare global { interface Window {} }\nrun();",
        ";                                     \nrun();",
    );
}

test "strip: declarations.default_exported_interface_declaration" {
    try expect_strip(
        .ts,
        "export default interface I {}\nrun();",
        ";                            \nrun();",
    );
}

test "strip: diagnostics.type_only_import_equals" {
    try expect_strip(
        .ts,
        "import type Model = require('model');\nrun();",
        ";                                    \nrun();",
    );
}

test "strip: expressions.as_expression" {
    try expect_strip(
        .ts,
        "const x = value as string;",
        "const x = value          ;",
    );
}

test "strip: expressions.const_assertion" {
    try expect_strip(
        .ts,
        "const value = [1, 2] as const;",
        "const value = [1, 2]         ;",
    );
}

test "strip: expressions.satisfies_expression" {
    try expect_strip(
        .ts,
        "const x = value satisfies Type;",
        "const x = value               ;",
    );
}

test "strip: expressions.non_null_expression" {
    try expect_strip(
        .ts,
        "const x = value!;",
        "const x = value ;",
    );
}

test "strip: expressions.chained_non_null_expressions" {
    try expect_strip(
        .ts,
        "const value = expr!!!;",
        "const value = expr   ;",
    );
}

test "strip: expressions.non_null_between_as_and_satisfies_expressions" {
    try expect_strip(
        .ts,
        "const value = (expr as A)! satisfies B;",
        "const value = (expr     )             ;",
    );
}

test "strip: expressions.non_null_after_instantiation_before_as_expression" {
    try expect_strip(
        .ts,
        "const value = (fn<A>)! as B;",
        "const value = (fn   )      ;",
    );
}

test "strip: expressions.non_null_expressions_in_assignment_target" {
    try expect_strip(
        .ts,
        "[left!, right!] = values;",
        "[left , right ] = values;",
    );
}

test "strip: expressions.as_expression_in_assignment_target" {
    try expect_strip(
        .ts,
        "[left as Type] = values;",
        "[left        ] = values;",
    );
}

test "strip: expressions.satisfies_expression_in_assignment_target" {
    try expect_strip(
        .ts,
        "[left satisfies Type] = values;",
        "[left               ] = values;",
    );
}

test "strip: expressions.non_null_instantiation_expression" {
    try expect_strip(
        .ts,
        "const value = (make!)<Type>;",
        "const value = (make )      ;",
    );
}

test "strip: expressions.non_null_generic_call_with_non_null_argument" {
    try expect_strip(
        .ts,
        "const value = (fn!)<T>(argument!);",
        "const value = (fn )   (argument );",
    );
}

test "strip: expressions.non_null_optional_call_with_type_arguments" {
    try expect_strip(
        .ts,
        "fn!?.<Type>(value);",
        "fn ?.      (value);",
    );
}

test "strip: expressions.non_null_new_expression_with_type_arguments" {
    try expect_strip(
        .ts,
        "const value = new (Map!)<Key, Value>();",
        "const value = new (Map )            ();",
    );
}

test "strip: expressions.as_expression_in_jsx_child" {
    try expect_strip(
        .tsx,
        "const element = <div>{value as string}</div>;",
        "const element = <div>{value          }</div>;",
    );
}

test "strip: expressions.type_arguments_in_jsx_opening_element" {
    try expect_strip(
        .tsx,
        "const element = <Component<Type> />;",
        "const element = <Component       />;",
    );
}

test "strip: expressions.parameter_annotation_in_jsx_attribute" {
    try expect_strip(
        .tsx,
        "const element = <Component render={(value: Type) => value} />;",
        "const element = <Component render={(value      ) => value} />;",
    );
}

test "strip: expressions.chained_suffix_assertions" {
    try expect_strip(
        .ts,
        "const value = input as unknown satisfies Type;",
        "const value = input                          ;",
    );
}

test "strip: expressions.parenthesized_template_literal_array_assertion" {
    try expect_strip(
        .ts,
        "let value = ['csv', 'json'] as (`csv` | `json`)[];",
        "let value = ['csv', 'json']                      ;",
    );
}

test "strip: expressions.safe_assertion_before_looser_binary_operator" {
    try expect_strip(
        .ts,
        "const value = 1 * 1 as number + 2;",
        "const value = 1 * 1           + 2;",
    );
}

test "strip: expressions.safe_assertion_between_left_associative_operators" {
    try expect_strip(
        .ts,
        "const value = 2 * 3 as number * 2;",
        "const value = 2 * 3           * 2;",
    );
}

test "strip: expressions.unary_assertion_left_of_exponentiation" {
    // Keep the emitted JavaScript valid when erasing the assertion.
    try expect_strip(
        .ts,
        "const value = -input as number ** 2;",
        "const value =(-input         ) ** 2;",
    );
}

test "strip: expressions.regular_expression_text_is_not_erased" {
    try expect_strip(
        .ts,
        "const value = [/as\\s+Type/, input as Type];",
        "const value = [/as\\s+Type/, input        ];",
    );
}

test "strip: expressions.template_quasi_text_is_not_erased" {
    try expect_strip(
        .ts,
        "const value = `as Type ${input as Type}`;",
        "const value = `as Type ${input        }`;",
    );
}

test "strip: expressions.type_arguments_in_decorator_expression" {
    try expect_strip(
        .ts,
        "@decorate<Type>\nclass C {}",
        "@decorate      \nclass C {}",
    );
}

test "strip: generics.function_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "function id<T>(value: T) {}",
        "function id   (value   ) {}",
    );
}

test "strip: generics.function_expression_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "const f = function<T>(value: T) {};",
        "const f = function   (value   ) {};",
    );
}

test "strip: generics.class_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "class C<T> {}",
        "class C    {}",
    );
}

test "strip: generics.class_expression_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "const C = class<T> {};",
        "const C = class    {};",
    );
}

test "strip: generics.constrained_defaulted_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "function f<T extends Base = Default>() {}",
        "function f                          () {}",
    );
}

test "strip: generics.class_method_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "class C { method<T>() {} }",
        "class C { method   () {} }",
    );
}

test "strip: generics.object_method_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "const object = { method<T>() {} };",
        "const object = { method   () {} };",
    );
}

test "strip: generics.single_line_arrow_type_parameter_declaration" {
    try expect_strip(
        .ts,
        "const f = <T>(value) => value;",
        "const f =    (value) => value;",
    );
}

test "strip: generics.call_type_argument_instantiation" {
    try expect_strip(
        .ts,
        "id<string>(value);",
        "id        (value);",
    );
}

test "strip: generics.optional_call_type_argument_instantiation" {
    try expect_strip(
        .ts,
        "object.method?.<Type>(value);",
        "object.method?.      (value);",
    );
}

test "strip: generics.instantiation_expression_type_arguments" {
    try expect_strip(
        .ts,
        "const f = make<string>;",
        "const f = make        ;",
    );
}

test "strip: generics.new_expression_type_arguments" {
    try expect_strip(
        .ts,
        "const value = new Box<Type>();",
        "const value = new Box      ();",
    );
}

test "strip: generics.new_expression_type_arguments_without_parentheses" {
    try expect_strip(
        .ts,
        "const value = new Box<Type>;",
        "const value = new Box      ;",
    );
}

test "strip: generics.super_method_call_type_arguments" {
    try expect_strip(
        .ts,
        "class C extends B { method() { super.method<Type>(); } }",
        "class C extends B { method() { super.method      (); } }",
    );
}

test "strip: generics.tagged_template_type_arguments" {
    try expect_strip(
        .ts,
        "tag<Type>`value`;",
        "tag      `value`;",
    );
}

test "strip: generics.multiline_async_arrow_type_parameters" {
    try expect_strip(
        .ts,
        "const f = async <\nType\n>(value: Type) => value;",
        "const f = async (\n    \n  value      ) => value;",
    );
}

test "strip: generics.multiline_returned_arrow_type_parameters" {
    try expect_strip(
        .ts,
        "function f() { return<Type>\n(value: Type) => value; }",
        "function f() { return(     \n value      ) => value; }",
    );
}

test "strip: generics.multiline_thrown_arrow_type_parameters" {
    try expect_strip(
        .ts,
        "function f() { throw<Type>\n(value: Type) => value; }",
        "function f() { throw(     \n value      ) => value; }",
    );
}

test "strip: generics.multiline_yielded_arrow_type_parameters" {
    try expect_strip(
        .ts,
        "function* f() { yield<Type>\n(value: Type) => value; }",
        "function* f() { yield(     \n value      ) => value; }",
    );
}

test "strip: generics.multiline_plain_arrow_type_parameters_need_no_parenthesis_move" {
    try expect_strip(
        .ts,
        "const f = <Type>\n(value: Type) => value;",
        "const f =       \n(value      ) => value;",
    );
}

test "strip: generics.nested_generic_arrow_type_argument" {
    try expect_strip(
        .ts,
        "const value = foo<<T>(x: T) => number>(() => 1);",
        "const value = foo                     (() => 1);",
    );
}

test "strip: modules.whole_type_only_import" {
    try expect_strip(
        .ts,
        "import type { T } from 'm';\nrun();",
        ";                          \nrun();",
    );
}

test "strip: modules.default_type_only_import" {
    try expect_strip(
        .ts,
        "import type T from 'm';\nrun();",
        ";                      \nrun();",
    );
}

test "strip: modules.namespace_type_only_import" {
    try expect_strip(
        .ts,
        "import type * as T from 'm';\nrun();",
        ";                           \nrun();",
    );
}

test "strip: modules.named_type_only_import_item" {
    try expect_strip(
        .ts,
        "import { type A, B } from 'm';",
        "import {         B } from 'm';",
    );
}

test "strip: modules.middle_type_only_import_item" {
    try expect_strip(
        .ts,
        "import { A, type B, C } from 'm';",
        "import { A,         C } from 'm';",
    );
}

test "strip: modules.last_type_only_import_item" {
    try expect_strip(
        .ts,
        "import { A, type B } from 'm';",
        "import { A,        } from 'm';",
    );
}

test "strip: modules.sole_inline_type_only_import_item" {
    try expect_strip(
        .ts,
        "import { type A } from 'm';",
        "import {        } from 'm';",
    );
}

test "strip: modules.aliased_inline_type_only_import_item" {
    try expect_strip(
        .ts,
        "import { type A as B, C } from 'm';",
        "import {              C } from 'm';",
    );
}

test "strip: modules.consecutive_inline_type_only_import_items" {
    try expect_strip(
        .ts,
        "import { type A, type B, C } from 'm';",
        "import {                 C } from 'm';",
    );
}

test "strip: modules.last_inline_type_only_import_item_before_comment" {
    try expect_strip(
        .ts,
        "import { value, type T /* comment */ } from 'm';",
        "import { value,        /* comment */ } from 'm';",
    );
}

test "strip: modules.whole_type_only_export" {
    try expect_strip(
        .ts,
        "export type { T } from 'm';\nrun();",
        ";                          \nrun();",
    );
}

test "strip: modules.named_type_only_export_item" {
    try expect_strip(
        .ts,
        "export { type A, B };",
        "export {         B };",
    );
}

test "strip: modules.middle_type_only_export_item" {
    try expect_strip(
        .ts,
        "export { A, type B, C };",
        "export { A,         C };",
    );
}

test "strip: modules.last_type_only_export_item" {
    try expect_strip(
        .ts,
        "export { A, type B };",
        "export { A,        };",
    );
}

test "strip: modules.sole_inline_type_only_export_item" {
    try expect_strip(
        .ts,
        "export { type A };",
        "export {        };",
    );
}

test "strip: modules.aliased_inline_type_only_export_item" {
    try expect_strip(
        .ts,
        "export { type A as B, C };",
        "export {              C };",
    );
}

test "strip: modules.consecutive_inline_type_only_export_items" {
    try expect_strip(
        .ts,
        "export { type A, type B, C };",
        "export {                 C };",
    );
}

test "strip: modules.type_only_export_all" {
    try expect_strip(
        .ts,
        "export type * from 'm';\nrun();",
        ";                      \nrun();",
    );
}

test "strip: modules.type_only_namespace_export_all" {
    try expect_strip(
        .ts,
        "export type * as ns from 'm';\nrun();",
        ";                            \nrun();",
    );
}

test "strip: modules.exported_type_alias_declaration" {
    try expect_strip(
        .ts,
        "export type T = string;\nrun();",
        ";                      \nrun();",
    );
}

test "strip: modules.qualified_type_only_import_equals" {
    try expect_strip(
        .ts,
        "import type Alias = Namespace.Member;\nrun();",
        ";                                    \nrun();",
    );
}

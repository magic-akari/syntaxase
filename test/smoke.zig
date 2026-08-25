const std = @import("std");
const syntaxase = @import("syntaxase");

test "transform is callable through the public module" {
    const allocator = std.testing.allocator;
    var result = try syntaxase.transform(
        allocator,
        "const answer: number = 42;\n",
        .{},
    );
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings("const answer         = 42;\n", result.code);
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
}

test "stripTypes is callable through the public module" {
    const allocator = std.testing.allocator;
    var result = try syntaxase.stripTypes(
        allocator,
        "export type Answer = number;\nexport const answer = 42;\n",
        .{},
    );
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "                            \nexport const answer = 42;\n",
        result.code,
    );
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
}

test "native into APIs append to caller-owned output" {
    const allocator = std.testing.allocator;
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    try output.appendSlice(allocator, "prefix:");

    var transformed = try syntaxase.transform_into(
        allocator,
        &output,
        "const value: number = 1;\n",
        .{},
    );
    defer transformed.deinit(allocator);
    try std.testing.expectEqualStrings(
        "prefix:const value         = 1;\n",
        output.items,
    );

    var stripped = try syntaxase.strip_types_into(
        allocator,
        &output,
        "type T = number;\n",
        .{},
    );
    defer stripped.deinit(allocator);
    try std.testing.expectEqualStrings(
        "prefix:const value         = 1;\n                \n",
        output.items,
    );
}

test "stripTypes accepts TSX through the public module" {
    const allocator = std.testing.allocator;
    const source = "const element = <Component<Type> value={input as Type} />;\n";
    var result = try syntaxase.stripTypes(allocator, source, .{ .lang = .tsx });
    defer result.deinit(allocator);

    try std.testing.expectEqualStrings(
        "const element = <Component       value={input        } />;\n",
        result.code,
    );
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
}

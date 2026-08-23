//! Freestanding WebAssembly entry point for Syntaxase's string API.
//!
//! The JavaScript bridge writes one contiguous input buffer containing source,
//! the first JSX option, and the second JSX option. `run` returns a
//! length-prefixed UTF-8 string (`[u32 byte_length][bytes]`) or zero on a hard
//! transform failure.

const std = @import("std");
const normalized_transform = @import("normalized_transform");

const allocator = std.heap.wasm_allocator;

export fn alloc(len: usize) [*]u8 {
    const allocation_len = @max(len, 1);
    return (allocator.alloc(u8, allocation_len) catch @trap()).ptr;
}

export fn free(ptr: [*]u8, len: usize) void {
    allocator.free(ptr[0..len]);
}

export fn run(
    ptr: [*]const u8,
    source_len: usize,
    first_option_len: usize,
    second_option_len: usize,
    raw_mode: u32,
) usize {
    const output = transform(
        ptr,
        source_len,
        first_option_len,
        second_option_len,
        raw_mode,
    ) catch return 0;
    return @intFromPtr(output.ptr);
}

fn transform(
    ptr: [*]const u8,
    source_len: usize,
    first_option_len: usize,
    second_option_len: usize,
    raw_mode: u32,
) ![]u8 {
    const first_option_start = source_len;
    const second_option_start = try std.math.add(
        usize,
        first_option_start,
        first_option_len,
    );
    const input_len = try std.math.add(
        usize,
        second_option_start,
        second_option_len,
    );
    const input = ptr[0..input_len];
    const source = input[0..source_len];
    const first_option = input[first_option_start..second_option_start];
    const second_option = input[second_option_start..input_len];
    const mode = normalized_transform.parse_mode(raw_mode) orelse
        return error.InvalidMode;

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try output.resize(allocator, 4);

    var info = try normalized_transform.run_into(
        allocator,
        &output,
        source,
        mode,
        first_option,
        second_option,
    );
    defer info.deinit(allocator);

    const code_len = output.items.len - 4;
    if (code_len > std.math.maxInt(u32)) return error.OutputTooLarge;
    std.mem.writeInt(u32, output.items[0..4], @intCast(code_len), .little);
    return output.toOwnedSlice(allocator);
}

//! Generate the standalone JavaScript module containing the WASM bytes.

const std = @import("std");

const prefix = "export default Uint8Array.fromBase64(\"";
const suffix = "\");\n";
const maximum_wasm_size = 2 * 1024 * 1024;

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    if (args.len != 3) return error.InvalidArgument;

    const wasm = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        args[1],
        allocator,
        .limited(maximum_wasm_size),
    );
    const encoded_len = std.base64.standard.Encoder.calcSize(wasm.len);
    const output_len = prefix.len + encoded_len + suffix.len;
    const output = try allocator.alloc(u8, output_len);

    @memcpy(output[0..prefix.len], prefix);
    const encoded = output[prefix.len..][0..encoded_len];
    _ = std.base64.standard.Encoder.encode(encoded, wasm);
    @memcpy(output[prefix.len + encoded_len ..], suffix);

    try std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = args[2],
        .data = output,
    });
}

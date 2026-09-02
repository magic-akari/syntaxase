const syntaxase = @import("root.zig");

pub const TransformResult = syntaxase.TransformResult;
pub const stripTypes = syntaxase.stripTypes;
pub const transform = syntaxase.transform;
pub const type_strip_benchmark = @import("transform/type_strip_benchmark.zig");

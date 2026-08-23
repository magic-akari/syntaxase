const std = @import("std");

const Allocator = std.mem.Allocator;

const named = std.StaticStringMap([]const u8).initComptime(.{
    .{ "quot", "\"" }, .{ "amp", "&" }, .{ "apos", "'" }, .{ "lt", "<" }, .{ "gt", ">" },
    .{ "nbsp", " " },
    .{ "iexcl", "¡" },
    .{ "cent", "¢" },
    .{ "pound", "£" },
    .{ "curren", "¤" },
    .{ "yen", "¥" },
    .{ "brvbar", "¦" },
    .{ "sect", "§" },
    .{ "uml", "¨" },
    .{ "copy", "©" },
    .{ "ordf", "ª" },
    .{ "laquo", "«" },
    .{ "not", "¬" },
    .{ "shy", "­" },
    .{ "reg", "®" },
    .{ "macr", "¯" },
    .{ "deg", "°" },
    .{ "plusmn", "±" },
    .{ "sup2", "²" },
    .{ "sup3", "³" },
    .{ "acute", "´" },
    .{ "micro", "µ" },
    .{ "para", "¶" },
    .{ "middot", "·" },
    .{ "cedil", "¸" },
    .{ "sup1", "¹" },
    .{ "ordm", "º" },
    .{ "raquo", "»" },
    .{ "frac14", "¼" },
    .{ "frac12", "½" },
    .{ "frac34", "¾" },
    .{ "iquest", "¿" },
    .{ "Agrave", "À" },
    .{ "Aacute", "Á" },
    .{ "Acirc", "Â" },
    .{ "Atilde", "Ã" },
    .{ "Auml", "Ä" },
    .{ "Aring", "Å" },
    .{ "AElig", "Æ" },
    .{ "Ccedil", "Ç" },
    .{ "Egrave", "È" },
    .{ "Eacute", "É" },
    .{ "Ecirc", "Ê" },
    .{ "Euml", "Ë" },
    .{ "Igrave", "Ì" },
    .{ "Iacute", "Í" },
    .{ "Icirc", "Î" },
    .{ "Iuml", "Ï" },
    .{ "ETH", "Ð" },
    .{ "Ntilde", "Ñ" },
    .{ "Ograve", "Ò" },
    .{ "Oacute", "Ó" },
    .{ "Ocirc", "Ô" },
    .{ "Otilde", "Õ" },
    .{ "Ouml", "Ö" },
    .{ "times", "×" },
    .{ "Oslash", "Ø" },
    .{ "Ugrave", "Ù" },
    .{ "Uacute", "Ú" },
    .{ "Ucirc", "Û" },
    .{ "Uuml", "Ü" },
    .{ "Yacute", "Ý" },
    .{ "THORN", "Þ" },
    .{ "szlig", "ß" },
    .{ "agrave", "à" },
    .{ "aacute", "á" },
    .{ "acirc", "â" },
    .{ "atilde", "ã" },
    .{ "auml", "ä" },
    .{ "aring", "å" },
    .{ "aelig", "æ" },
    .{ "ccedil", "ç" },
    .{ "egrave", "è" },
    .{ "eacute", "é" },
    .{ "ecirc", "ê" },
    .{ "euml", "ë" },
    .{ "igrave", "ì" },
    .{ "iacute", "í" },
    .{ "icirc", "î" },
    .{ "iuml", "ï" },
    .{ "eth", "ð" },
    .{ "ntilde", "ñ" },
    .{ "ograve", "ò" },
    .{ "oacute", "ó" },
    .{ "ocirc", "ô" },
    .{ "otilde", "õ" },
    .{ "ouml", "ö" },
    .{ "divide", "÷" },
    .{ "oslash", "ø" },
    .{ "ugrave", "ù" },
    .{ "uacute", "ú" },
    .{ "ucirc", "û" },
    .{ "uuml", "ü" },
    .{ "yacute", "ý" },
    .{ "thorn", "þ" },
    .{ "yuml", "ÿ" },
    .{ "OElig", "Œ" },
    .{ "oelig", "œ" },
    .{ "Scaron", "Š" },
    .{ "scaron", "š" },
    .{ "Yuml", "Ÿ" },
    .{ "fnof", "ƒ" },
    .{ "circ", "ˆ" },
    .{ "tilde", "˜" },
    .{ "Alpha", "Α" },
    .{ "Beta", "Β" },
    .{ "Gamma", "Γ" },
    .{ "Delta", "Δ" },
    .{ "Epsilon", "Ε" },
    .{ "Zeta", "Ζ" },
    .{ "Eta", "Η" },
    .{ "Theta", "Θ" },
    .{ "Iota", "Ι" },
    .{ "Kappa", "Κ" },
    .{ "Lambda", "Λ" },
    .{ "Mu", "Μ" },
    .{ "Nu", "Ν" },
    .{ "Xi", "Ξ" },
    .{ "Omicron", "Ο" },
    .{ "Pi", "Π" },
    .{ "Rho", "Ρ" },
    .{ "Sigma", "Σ" },
    .{ "Tau", "Τ" },
    .{ "Upsilon", "Υ" },
    .{ "Phi", "Φ" },
    .{ "Chi", "Χ" },
    .{ "Psi", "Ψ" },
    .{ "Omega", "Ω" },
    .{ "alpha", "α" },
    .{ "beta", "β" },
    .{ "gamma", "γ" },
    .{ "delta", "δ" },
    .{ "epsilon", "ε" },
    .{ "zeta", "ζ" },
    .{ "eta", "η" },
    .{ "theta", "θ" },
    .{ "iota", "ι" },
    .{ "kappa", "κ" },
    .{ "lambda", "λ" },
    .{ "mu", "μ" },
    .{ "nu", "ν" },
    .{ "xi", "ξ" },
    .{ "omicron", "ο" },
    .{ "pi", "π" },
    .{ "rho", "ρ" },
    .{ "sigmaf", "ς" },
    .{ "sigma", "σ" },
    .{ "tau", "τ" },
    .{ "upsilon", "υ" },
    .{ "phi", "φ" },
    .{ "chi", "χ" },
    .{ "psi", "ψ" },
    .{ "omega", "ω" },
    .{ "thetasym", "ϑ" },
    .{ "upsih", "ϒ" },
    .{ "piv", "ϖ" },
    .{ "ensp", " " },
    .{ "emsp", " " },
    .{ "thinsp", " " },
    .{ "zwnj", "‌" },
    .{ "zwj", "‍" },
    .{ "lrm", "‎" },
    .{ "rlm", "‏" },
    .{ "ndash", "–" },
    .{ "mdash", "—" },
    .{ "lsquo", "‘" },
    .{ "rsquo", "’" },
    .{ "sbquo", "‚" },
    .{ "ldquo", "“" },
    .{ "rdquo", "”" },
    .{ "bdquo", "„" },
    .{ "dagger", "†" },
    .{ "Dagger", "‡" },
    .{ "bull", "•" },
    .{ "hellip", "…" },
    .{ "permil", "‰" },
    .{ "prime", "′" },
    .{ "Prime", "″" },
    .{ "lsaquo", "‹" },
    .{ "rsaquo", "›" },
    .{ "oline", "‾" },
    .{ "frasl", "⁄" },
    .{ "euro", "€" },
    .{ "image", "ℑ" },
    .{ "weierp", "℘" },
    .{ "real", "ℜ" },
    .{ "trade", "™" },
    .{ "alefsym", "ℵ" },
    .{ "larr", "←" },
    .{ "uarr", "↑" },
    .{ "rarr", "→" },
    .{ "darr", "↓" },
    .{ "harr", "↔" },
    .{ "crarr", "↵" },
    .{ "lArr", "⇐" },
    .{ "uArr", "⇑" },
    .{ "rArr", "⇒" },
    .{ "dArr", "⇓" },
    .{ "hArr", "⇔" },
    .{ "forall", "∀" },
    .{ "part", "∂" },
    .{ "exist", "∃" },
    .{ "empty", "∅" },
    .{ "nabla", "∇" },
    .{ "isin", "∈" },
    .{ "notin", "∉" },
    .{ "ni", "∋" },
    .{ "prod", "∏" },
    .{ "sum", "∑" },
    .{ "minus", "−" },
    .{ "lowast", "∗" },
    .{ "radic", "√" },
    .{ "prop", "∝" },
    .{ "infin", "∞" },
    .{ "ang", "∠" },
    .{ "and", "∧" },
    .{ "or", "∨" },
    .{ "cap", "∩" },
    .{ "cup", "∪" },
    .{ "int", "∫" },
    .{ "there4", "∴" },
    .{ "sim", "∼" },
    .{ "cong", "≅" },
    .{ "asymp", "≈" },
    .{ "ne", "≠" },
    .{ "equiv", "≡" },
    .{ "le", "≤" },
    .{ "ge", "≥" },
    .{ "sub", "⊂" },
    .{ "sup", "⊃" },
    .{ "nsub", "⊄" },
    .{ "sube", "⊆" },
    .{ "supe", "⊇" },
    .{ "oplus", "⊕" },
    .{ "otimes", "⊗" },
    .{ "perp", "⊥" },
    .{ "sdot", "⋅" },
    .{ "lceil", "⌈" },
    .{ "rceil", "⌉" },
    .{ "lfloor", "⌊" },
    .{ "rfloor", "⌋" },
    .{ "lang", "〈" },
    .{ "rang", "〉" },
    .{ "loz", "◊" },
    .{ "spades", "♠" },
    .{ "clubs", "♣" },
    .{ "hearts", "♥" },
    .{ "diams", "♦" },
});

/// Decodes exactly the character-reference grammar accepted by the JavaScript
/// implementation. Unknown and malformed references remain source text.
pub fn decode(allocator: Allocator, value: []const u8) Allocator.Error![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    var cursor: usize = 0;
    while (cursor < value.len) {
        const amp = std.mem.indexOfScalarPos(u8, value, cursor, '&') orelse {
            try output.appendSlice(allocator, value[cursor..]);
            break;
        };
        try output.appendSlice(allocator, value[cursor..amp]);
        const parsed = parse_entity(value, amp);
        if (parsed) |entity| {
            switch (entity.value) {
                .text => |text| try output.appendSlice(allocator, text),
                .code_point => |code_point| try append_code_point(&output, allocator, code_point),
            }
            cursor = entity.end;
        } else {
            try output.append(allocator, '&');
            cursor = amp + 1;
        }
    }
    return output.toOwnedSlice(allocator);
}

const Entity = struct {
    end: usize,
    value: union(enum) { text: []const u8, code_point: u21 },
};

fn parse_entity(value: []const u8, amp: usize) ?Entity {
    const body_start = amp + 1;
    if (body_start >= value.len) return null;
    if (value[body_start] == '#') return parse_numeric(value, body_start);
    if (!std.ascii.isAlphabetic(value[body_start])) return null;

    var end = body_start + 1;
    while (end < value.len and end - body_start < 9 and std.ascii.isAlphanumeric(value[end])) {
        end += 1;
    }
    if (end >= value.len or value[end] != ';') return null;
    const replacement = named.get(value[body_start..end]) orelse return null;
    return .{ .end = end + 1, .value = .{ .text = replacement } };
}

fn parse_numeric(value: []const u8, hash: usize) ?Entity {
    var digits_start = hash + 1;
    if (digits_start >= value.len) return null;
    var radix: u8 = 10;
    var maximum_digits: usize = 8;
    if (value[digits_start] == 'x' or value[digits_start] == 'X') {
        radix = 16;
        maximum_digits = 7;
        digits_start += 1;
    }
    var end = digits_start;
    while (end < value.len and end - digits_start < maximum_digits) : (end += 1) {
        const valid = if (radix == 16) std.ascii.isHex(value[end]) else std.ascii.isDigit(value[end]);
        if (!valid) break;
    }
    if (end == digits_start or end >= value.len or value[end] != ';') return null;
    const code_point = std.fmt.parseInt(u21, value[digits_start..end], radix) catch return null;
    if (code_point > 0x10ffff) return null;
    return .{ .end = end + 1, .value = .{ .code_point = code_point } };
}

fn append_code_point(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    code_point: u21,
) Allocator.Error!void {
    if (code_point >= 0xd800 and code_point <= 0xdfff) {
        // WTF-8 retains JavaScript's lone UTF-16 surrogate until js_string
        // serializes it as a `\\uXXXX` escape.
        try output.appendSlice(allocator, &.{
            @intCast(0xe0 | (code_point >> 12)),
            @intCast(0x80 | ((code_point >> 6) & 0x3f)),
            @intCast(0x80 | (code_point & 0x3f)),
        });
        return;
    }
    var bytes: [4]u8 = undefined;
    const length = std.unicode.utf8Encode(code_point, &bytes) catch unreachable;
    try output.appendSlice(allocator, bytes[0..length]);
}

test "JSX entities decode named numeric and adjacent references" {
    const allocator = std.testing.allocator;
    const output = try decode(allocator, "&amp;&#65;&#x1f600;&unknown;&amp&amp;");
    defer allocator.free(output);
    try std.testing.expectEqualStrings("&A😀&unknown;&amp&", output);
}

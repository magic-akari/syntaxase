pub const Automatic = struct {
    development: bool = false,
    import_source: []const u8 = "react",
};

pub const Classic = struct {
    pragma: []const u8 = "React.createElement",
    pragma_frag: []const u8 = "React.Fragment",
};

pub const Config = union(enum) {
    disabled,
    automatic: Automatic,
    classic: Classic,
    preserve,

    pub fn parses_jsx(self: Config) bool {
        return self != .disabled;
    }

    pub fn lowers_jsx(self: Config) bool {
        return switch (self) {
            .automatic, .classic => true,
            .disabled, .preserve => false,
        };
    }
};

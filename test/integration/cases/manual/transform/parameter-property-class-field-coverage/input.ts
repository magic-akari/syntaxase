const computedOnly = "computedOnly";

class Coverage {
	covered!: number;
	declare declared: number;
	static staticOnly: number;
	#privateOnly: number;
	[computedOnly]: number;
	accessor accessorOnly: number;
	methodOnly() {}

	constructor(
		public covered: number,
		public declared: number,
		public staticOnly: number,
		public privateOnly: number,
		public computedOnly: number,
		public accessorOnly: number,
		public methodOnly: number,
	) {}
}

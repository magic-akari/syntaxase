const computedOnly = "computedOnly";

class Coverage {staticOnly;privateOnly;computedOnly;accessorOnly;methodOnly;
	covered         ;
	        declared;         
	static staticOnly        ;
	#privateOnly        ;
	[computedOnly]        ;
	accessor accessorOnly        ;
	methodOnly() {}

	constructor(
		       covered        ,
		       declared        ,
		       staticOnly        ,
		       privateOnly        ,
		       computedOnly        ,
		       accessorOnly        ,
		       methodOnly        ,
	) {;this.covered=covered;this.declared=declared;this.staticOnly=staticOnly;this.privateOnly=privateOnly;this.computedOnly=computedOnly;this.accessorOnly=accessorOnly;this.methodOnly=methodOnly;}
}

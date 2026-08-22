class Base {}

class StatementDerived extends Base {value;
	constructor(       value        , mode        ) {
		if (mode === 0) super(),this.value=value;
		else if (mode === 1) (super(),this.value=value);
		else super(),this.value=value;
	}
}

class ValueDerived extends Base {value;
	constructor(       value        ) {
		if ([super(),this.value=value][0]) {}
	}
}

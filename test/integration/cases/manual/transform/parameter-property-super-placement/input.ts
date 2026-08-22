class Base {}

class StatementDerived extends Base {
	constructor(public value: number, mode: number) {
		if (mode === 0) super();
		else if (mode === 1) (super());
		else super();
	}
}

class ValueDerived extends Base {
	constructor(public value: number) {
		if (super()) {}
	}
}

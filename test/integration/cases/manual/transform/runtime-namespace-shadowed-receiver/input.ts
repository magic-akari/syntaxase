const N1 = 2;

namespace N {
	export namespace N {
		export function inner(): 1 {
			return 1;
		}
	}

	export function after(): 2 {
		return N1;
	}
}

export const observed = [N.N.inner(), N.after()];

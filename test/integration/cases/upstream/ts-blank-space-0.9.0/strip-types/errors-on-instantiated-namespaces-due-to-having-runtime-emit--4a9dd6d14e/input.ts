
        namespace A { 1; }
        namespace B { globalThis; }
        namespace C { export let x; }
        namespace D { declare let x; }
        namespace E { export type T = any; 2; }
        namespace F { export namespace Inner { 3; } }
        namespace G.H { 4; }
        namespace I { export import X = E.T }
        namespace J { {} }
    
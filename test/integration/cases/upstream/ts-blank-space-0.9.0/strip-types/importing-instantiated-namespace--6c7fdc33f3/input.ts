
        namespace A { export let x = 1; }
        namespace B { import x = A.x; }
        namespace C { export import x = A.x; }
        
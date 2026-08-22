const classView = <div>{class Box { constructor(public value: number) {} }}</div>;
const enumView = <div>{(() => { enum E { A } return E.A; })()}</div>;
enum Outer { A = (() => { enum Inner { B } return Inner.B; })() }

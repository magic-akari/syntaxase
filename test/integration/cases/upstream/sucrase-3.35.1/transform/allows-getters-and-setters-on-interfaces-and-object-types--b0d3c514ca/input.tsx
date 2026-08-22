
      interface A {
        get foo(): string;
        set foo(s: string);
      }
      type T = {
        get bar(): number;
        set bar(n: number);
      }
    
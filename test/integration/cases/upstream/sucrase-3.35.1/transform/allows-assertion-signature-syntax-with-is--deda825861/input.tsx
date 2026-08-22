
      function assertIsDefined<T>(x: T): asserts x is NonNullable<T> {
        if (x == null) throw "oh no";
      }
    
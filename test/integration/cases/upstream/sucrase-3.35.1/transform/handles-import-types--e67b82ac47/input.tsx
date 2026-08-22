
      type T1 = import("./foo");
      type T2 = typeof import("./bar");
      type T3 = import("./bar").Point;
      type T4 = import("./utils").HashTable<number>;
    
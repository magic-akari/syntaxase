
      class A extends B {
        constructor(readonly x, private y = 2, z: number = 3) {
          console.log("Hello");
          super();
          console.log("World");
        }
      }
    
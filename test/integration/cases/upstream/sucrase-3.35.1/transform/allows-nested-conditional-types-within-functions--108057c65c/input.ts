
      type A = T extends (x: A extends B ? C : D) => void ? 1 : 0;
    
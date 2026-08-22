
      type A = T extends (infer U extends number ? U : T) ? U : T;
    
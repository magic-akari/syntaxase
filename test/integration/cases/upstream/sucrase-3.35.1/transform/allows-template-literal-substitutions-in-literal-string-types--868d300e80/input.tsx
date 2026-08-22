
      type Color = "red" | "blue";
      type Quantity = "one" | "two";
      
      type SeussFish = `${Quantity | Color} fish`;
      const fish: SeussFish = "blue fish";
    
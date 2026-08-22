
      const x: string | number = 1;
      if (x as number >= 5) {}
      if (y as unknown ?? false) {}
      if (x satisfies number >= 5) {}
      if (y satisfies unknown ?? false) {}
    
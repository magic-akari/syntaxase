
      const multiLineReturn = (
        x: number
      ): {
        value: number;
      } => ({value: x}); 
      setOutput(multiLineReturn(5).value)
    
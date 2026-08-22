
      import React from 'react';
      
      import Foo from './Foo';
      import Bar from './Bar';
      import someProp from './someProp';
      import lowercaseComponent from './lowercaseComponent';
      import div from './div';
      
      const x: Bar = 3;
      function render(): JSX.Element {
        return (
          <div>
            <Foo.Bar someProp="a" />
            <lowercaseComponent.Thing />
          </div>
        );
      }
    
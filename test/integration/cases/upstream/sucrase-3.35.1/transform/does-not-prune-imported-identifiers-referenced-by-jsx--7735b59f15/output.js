
      import React from 'react';
      
      import Foo from './Foo';
      import Bar from './Bar';
      import someProp from './someProp';
      import lowercaseComponent from './lowercaseComponent';
      import div from './div';
      
      const x      = 3;
      function render()              {
        return (
          React.createElement("div", null, 
            React.createElement(Foo.Bar, {"someProp": "a"}), 
            React.createElement(lowercaseComponent.Thing, null))
                
        );
      }
    

      import { someVariable } from './someFile';
      import { otherVariable } from './otherFile';
      
      function Foo(arg: (someVariable: any) => void, otherVariable) {
        console.log(arg, someVariable, otherVariable);
      }
    
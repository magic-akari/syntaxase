
      import A from 'a';
      import {default as B} from 'b';
      import 'c';
      import D from 'd';
      import 'd';
      import E from 'e';
      
      function f(a: A): boolean {
        return a instanceof A;
      }
      function g(b: B): boolean {
        return true;
      }
    
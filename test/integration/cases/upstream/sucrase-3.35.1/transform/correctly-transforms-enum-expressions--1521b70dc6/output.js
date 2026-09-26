
      import A from './A';
      
      var  E;(function(E){
        const Foo=A.Foo;E["Foo"]=Foo;if(typeof Foo!=="string")E[Foo]="Foo";
        const Bar=A.Bar;E["Bar"]=Bar;if(typeof Bar!=="string")E[Bar]="Bar";
      })(E||(E={}));
    
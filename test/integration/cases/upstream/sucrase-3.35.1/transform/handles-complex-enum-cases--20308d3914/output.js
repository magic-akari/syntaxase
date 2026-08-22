
      var  Foo;(function(Foo){
        const A=15.5;Foo[Foo["A"]=A]="A";
        Foo[Foo["Hello world"]=A / 2]="Hello world";
        Foo[Foo[""]=Foo["Hello world"] + 1]="";
        const D="foo".length;Foo[Foo["D"]=D]="D";
        const E=D / D;Foo[Foo["E"]=E]="E";
        const _debugger=4;Foo[Foo["debugger"]=_debugger]="debugger";
        const _default=7;Foo[Foo["default"]=_default]="default";
        Foo[Foo["!"]=E << E]="!";
        Foo[Foo["\n"]=Foo["!"] + 1]="\n";
        Foo[Foo[","]=Foo["\n"] + 1]=",";
        Foo[Foo["'"]=Foo[","] + 1]="'";
        Foo["f f"]="g g";
      })(Foo||(Foo={}));
    
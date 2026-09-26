
      var  Foo;(function(Foo){
        const A=15.5;Foo[Foo["A"]=A]="A";
        Foo[Foo["Hello world"]=A / 2]="Hello world";
        Foo[Foo[""]=Foo["Hello world"] + 1]="";
        const D="foo".length;Foo["D"]=D;if(typeof D!=="string")Foo[D]="D";
        const E=D / D;Foo["E"]=E;if(typeof E!=="string")Foo[E]="E";
        const _debugger=4;Foo[Foo["debugger"]=_debugger]="debugger";
        const _default=7;Foo[Foo["default"]=_default]="default";
        const _value=E << E;Foo["!"]=_value;if(typeof _value!=="string")Foo[_value]="!";
        Foo[Foo["\n"]=_value + 1]="\n";
        Foo[Foo[","]=Foo["\n"] + 1]=",";
        Foo[Foo["'"]=Foo[","] + 1]="'";
        Foo["f f"]="g g";
      })(Foo||(Foo={}));
    
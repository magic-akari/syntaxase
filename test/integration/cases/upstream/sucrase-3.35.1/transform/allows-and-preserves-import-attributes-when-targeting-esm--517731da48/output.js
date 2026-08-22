
      import jsonValue from "./file1.json" with {type: "json"};
      import implicitlyElidedImport from "./file2.json" with {type: "json"};
                                                                                 
      import "./file4.json" with {type: "json"};
      export {val} from './file5.json' with {type: "json"};
                                                                
      console.log(jsonValue);
    
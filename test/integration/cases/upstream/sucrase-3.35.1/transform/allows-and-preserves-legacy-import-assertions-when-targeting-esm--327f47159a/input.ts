
      import jsonValue from "./file1.json" assert {type: "json"};
      import implicitlyElidedImport from "./file2.json" assert {type: "json"};
      import type explicitlyElidedImport from "./file3.json" assert {type: "json"};
      import "./file4.json" assert {type: "json"};
      export {val} from './file5.json' assert {type: "json"};
      export type {val} from './file6.json' assert {type: "json"};
      console.log(jsonValue);
    
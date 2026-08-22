
      import jsonValue from "./file1.json" with {type: "json"};
      import implicitlyElidedImport from "./file2.json" with {type: "json"};
      import type explicitlyElidedImport from "./file3.json" with {type: "json"};
      import "./file4.json" with {type: "json"};
      export {val} from './file5.json' with {type: "json"};
      export type {val} from './file6.json' with {type: "json"};
      console.log(jsonValue);
    
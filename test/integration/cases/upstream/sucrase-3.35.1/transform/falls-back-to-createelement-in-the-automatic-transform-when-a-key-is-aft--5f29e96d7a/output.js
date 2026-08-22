
      _createElement("div", {...props, "key": "a"}, 
        _jsx("span", {}, "b"));
             
      _createElement("div", {...props, "key": "a"}, "Static children", "aren't treated differently in this case");
                                                                
             
      _jsx("div", {...props}, "c");
    
import { createElement as _createElement } from "react";
import { jsx as _jsx } from "react/jsx-runtime";
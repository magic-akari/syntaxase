
      _jsx("div", {});
      _jsx("div", {});
      _jsx("div", {"children": "Some text"});
      _jsxs("div", {"children": [...spreadChildrenIntentionallyMarkedStatic]});
      _jsx("div", {"children": expressionChild});
      _jsx("div", {"children": "Still just one child"});
      _jsxs("div", {"children": ["Two", "children"]});
      _jsxs("div", {"children": [_jsx(Child1, {}), _jsx(Child2, {})]});
      _jsxs("div", {"children": ["Child 1", _jsx(Child2, {}), child3]});
      _jsx("div", {"children": "One child"});
        
             
    
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
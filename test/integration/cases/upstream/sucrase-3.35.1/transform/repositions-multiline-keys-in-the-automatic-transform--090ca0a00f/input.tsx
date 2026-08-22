
      <div
        someProp="Hello"
        key={
          // We need to call computeKey here.
          computeKey()
        }
        someOtherProp={foo}
      >
        <span key={computeOtherKey()} className="bar" />
      </div>
      console.log("10 lines after the start of the div");
    
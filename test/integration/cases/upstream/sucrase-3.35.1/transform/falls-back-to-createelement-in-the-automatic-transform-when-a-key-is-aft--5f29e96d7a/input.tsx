
      <div {...props} key="a">
        <span key="b" />
      </div>;
      <div {...props} key="a">
        Static children{}aren't treated differently in this case
      </div>;
      <div key="c" {...props} />;
    
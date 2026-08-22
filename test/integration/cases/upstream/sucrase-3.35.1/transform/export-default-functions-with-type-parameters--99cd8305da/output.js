
      export default function flatMap      (list          , map                          )           {
        return list.reduce((memo, item) => memo.concat(map(item)), []            );
      }
    
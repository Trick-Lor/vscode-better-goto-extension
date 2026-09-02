    
    
    
    /* eslint-disable */  // 4-space indent so gg lands on char 5 (first non-blank), not char 1
/*
 * Better Go to Line/Column -- Playground & demo
 * ---------------------------------------------
 * Press Ctrl+G, then type a command (the leading ":" is optional):
 *
 *   Line / column    5         -> line 5
 *                    5:10      -> line 5, column 10
 *                    50%       -> halfway down the file
 *   Relative         +3   -2   -> 3 down / 2 up from the cursor
 *   Vim jumps        gg   G    -> first / last line
 *                    $  0  ^   -> end / start / first non-blank char
 *                    {  }      -> previous / next blank line
 *   Words            w  b  e   -> next / prev / end of a word
 *   Brackets         %         -> jump to the matching bracket
 *   Select / edit    v42       -> select to line 42
 *                    d5;9      -> delete the range line 5 .. line 9
 *   Ex commands      :1,5sort  -> sort the todo list below into order
 *                    :%s/foo/bar/g -> replace every foo with bar
 *
 * The content below is shaped so every command lands somewhere predictable.
 */

// column ruler (each "....+....N" marks 10 cols) -- try 5:999, $, 0, |, gM here:
const ruler = "....+....1....+....2....+....3....+....4....+....5";

const tiny = "i";   // a 1-char value -- a short line for the column-clamp edge

// nested brackets -- put the caret on a bracket and press % ; also [( ]) [{ ]} :
function build(node) {
    const pairs = [ { key: "a" }, { key: "b" }, { key: "c" } ];
    return pairs.map(function (p) { return wrap(p.key); });
}

// a longer string -- put the caret inside the quotes and press ci" :
const greeting = "hello from the better-goto playground";

// a short unsorted list -- put the caret on line 1 of this block and try :1,5sort ;
// try :%s/foo/bar/g too, it only touches the "foo" lines below:
const todo = "zebra";
const todoFoo = "foo one";
const todoAlpha = "alpha";
const todoFoo2 = "foo two";
const todoMango = "mango";

// sentences on one line -- hop between them with ( and ) :
// First sentence. Second sentence! A third one? And the last one here.

// a blank line sits above and below this paragraph -- try { and } :

const config = {
        enabled: true,        // indented line -- try ^ (first non-blank) vs 0, and g_
        retries: 3,
        names: ["alpha", "beta", "gamma"],
};

// words and WORDs -- try w b e, W B E, ge gE, and f F t T on this line:
let foo_bar = BAZ_qux + total.value(alpha, beta, gamma);

// Allman braces -- the "{" below sits in column 0, a target for ]] and [[ :
function section()
{
    return tiny;
}

function tail() {
    // padding so the file stays comfortably over 50 lines, for the H/M/L
    // viewport cases and the "open a file >= 50 lines" precondition.
    const steps = [10, 20, 30, 40, 50];
    let sum = 0;
    for (const s of steps) {
        sum = sum + s;
    }
    return sum;
}

// End of playground -- the last line, for G and the "line past end" clamp test.

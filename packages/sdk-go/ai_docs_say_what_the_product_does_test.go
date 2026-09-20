package driftstack

// The AI surface's doc comments ship to customers as godoc, and the AI example
// is copied into their code, so that text must say what the product does,
// never how it is built inside: no internal infrastructure names, no internal
// ticket or work ids, no agent names. Comments are read with go/parser, so
// what is checked is exactly the comment text — never a `//` inside a string.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

type internalReference struct {
	pattern *regexp.Regexp
	why     string
}

var internalReferences = []internalReference{
	{regexp.MustCompile(`(?i)\bharness\b`), `infrastructure name "harness"`},
	{regexp.MustCompile(`(?i)\bfleet\b`), `infrastructure name "fleet"`},
	{regexp.MustCompile(`(?i)\bcontrol[ -]plane\b`), `infrastructure name "control plane"`},
	{regexp.MustCompile(`(?i)\bobserver\b`), `infrastructure name "observer"`},
	{regexp.MustCompile(`(?i)\bvantage\b`), `infrastructure name "vantage"`},
	// Go's regexp has no lookahead, so "Node.js" and "node:" are removed first.
	{regexp.MustCompile(`(?i)\bnodes?\b`), `infrastructure name "node"`},
	{regexp.MustCompile(`\bMacs?\b`), `infrastructure name "Mac"`},
	{regexp.MustCompile(`\b8443\b`), "an internal port number"},
	{regexp.MustCompile(`\b[VW]-?\d{2,5}\b`), "an internal ticket id"},
	{regexp.MustCompile(`(?i)\b(?:sub-)?slice \d`), "an internal work item"},
	{regexp.MustCompile(`\bArc \d`), "an internal work item"},
	{regexp.MustCompile(`\bWave \d`), "an internal work item"},
	{regexp.MustCompile(`\bLK\.\d`), "an internal work item"},
	{regexp.MustCompile(`\bv2-#\d`), "an internal work item"},
	{regexp.MustCompile(`\bQ\.\d`), "an internal work item"},
	{regexp.MustCompile(`\b[PT]-\d+\b`), "an internal work item"},
	{regexp.MustCompile(`\bdoc-\d+`), "an internal planning document"},
	{regexp.MustCompile(`(?i)\bplanning \d+`), "an internal planning document"},
	{regexp.MustCompile(`\bTier-3\b`), "an internal decision label"},
	{regexp.MustCompile(`\bA[1-3]\b`), "an agent name"},
	{regexp.MustCompile(`(?i)\bfounder\b`), "a personal role"},
}

var notInfrastructure = regexp.MustCompile(`(?i)\bnode(?:\.js|:[a-z])`)

// The public proxy-test API spells these itself: `measured_from` comes back as
// "control_plane" or "fleet", and the request takes `?vantage=fleet`. An SDK
// that cannot name its own enum values documents nothing, so the quoted value
// and the query parameter are removed before matching. A bare `fleet`, or
// `fleet-vantage`, is still reported — see the control test below.
var wireValues = regexp.MustCompile(`"fleet"|\?vantage=fleet`)

func internalFindings(label, text string) []string {
	text = notInfrastructure.ReplaceAllString(text, "")
	text = wireValues.ReplaceAllString(text, "")
	var out []string
	for _, ref := range internalReferences {
		if m := ref.pattern.FindString(text); m != "" {
			out = append(out, label+": "+ref.why+` — "`+m+`"`)
		}
	}
	return out
}

// fileComments returns every comment group in a Go file, keyed by line.
func fileComments(t *testing.T, path string) map[int]string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	out := map[int]string{}
	for _, group := range f.Comments {
		out[fset.Position(group.Pos()).Line] = group.Text()
	}
	return out
}

// typeDocs returns the doc comments of the named types plus those of every
// method declared on them.
func typeDocs(t *testing.T, path string, names map[string]bool) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if !ok || !names[ts.Name.Name] {
					continue
				}
				out[ts.Name.Name] += d.Doc.Text() + ts.Doc.Text()
			}
		case *ast.FuncDecl:
			if d.Recv == nil || len(d.Recv.List) == 0 {
				continue
			}
			recv := d.Recv.List[0].Type
			if star, ok := recv.(*ast.StarExpr); ok {
				recv = star.X
			}
			if ident, ok := recv.(*ast.Ident); ok && names[ident.Name] {
				out[ident.Name] += "\n" + d.Doc.Text()
			}
		}
	}
	return out
}

var aiErrorTypes = map[string]bool{
	"ForbiddenError":                 true,
	"ConflictError":                  true,
	"BundledLlmBudgetExhaustedError": true,
	"BundledLlmConsentRequiredError": true,
	"ByokAnthropicRequiredError":     true,
}

func TestControlTheMatcherFlagsEachKindOfInternalReferenceAndPassesProductCopy(t *testing.T) {
	if got := internalFindings("planted", "the harness on node W1234 (Slice 3)"); len(got) != 4 {
		t.Errorf("planted #1 found %d: %v", len(got), got)
	}
	if got := internalFindings("planted", "see LK.3 and doc-132, agreed with A3"); len(got) != 3 {
		t.Errorf("planted #2 found %d: %v", len(got), got)
	}
	plain := "Stop the running task. Node.js tooling and import 'node:crypto' are fine. The browser runs your session."
	if got := internalFindings("plain", plain); len(got) != 0 {
		t.Errorf("plain copy flagged: %v", got)
	}
	wire := `measured_from is "control_plane" or "fleet", asked for with ?vantage=fleet`
	if got := internalFindings("wire", wire); len(got) != 0 {
		t.Errorf("the API's own enum values flagged: %v", got)
	}
	// …and the exemption is for those two spellings only.
	if got := internalFindings("prose", "a fleet-vantage test of a VPN proxy"); len(got) != 2 {
		t.Errorf("bare fleet / vantage in prose found %d: %v", len(got), got)
	}
}

func TestTheDocCollectorsReadRealTextSoAnEmptyScanCannotPassForACleanOne(t *testing.T) {
	comments := fileComments(t, "agent_sessions.go")
	if len(comments) < 40 {
		t.Fatalf("only %d comment groups read from agent_sessions.go", len(comments))
	}
	found := false
	for _, text := range comments {
		if strings.Contains(text, "Stop stops the session's running turn") {
			found = true
		}
	}
	if !found {
		t.Error("the Stop doc comment was not collected")
	}
	docs := typeDocs(t, "errors.go", aiErrorTypes)
	var got []string
	for name, doc := range docs {
		if len(doc) < 40 {
			t.Errorf("%s doc too short to be real: %q", name, doc)
		}
		got = append(got, name)
	}
	sort.Strings(got)
	if len(got) != len(aiErrorTypes) {
		t.Errorf("collected docs for %v", got)
	}
}

func TestEveryCommentInTheAgentSessionsFileIsFreeOfInternalReferences(t *testing.T) {
	var hits []string
	for line, text := range fileComments(t, "agent_sessions.go") {
		hits = append(hits, internalFindings("agent_sessions.go:"+strconv.Itoa(line), text)...)
	}
	if len(hits) > 0 {
		sort.Strings(hits)
		t.Errorf("internal references in customer-facing docs:\n%s", strings.Join(hits, "\n"))
	}
}

func TestTheAIErrorTypesDocumentThemselvesWithoutInternalReferences(t *testing.T) {
	var hits []string
	for name, doc := range typeDocs(t, "errors.go", aiErrorTypes) {
		hits = append(hits, internalFindings("errors.go "+name, doc)...)
	}
	if len(hits) > 0 {
		sort.Strings(hits)
		t.Errorf("internal references in customer-facing docs:\n%s", strings.Join(hits, "\n"))
	}
}

// The AI surface was swept first because it was written last. pkg.go.dev
// renders EVERY exported doc comment in this module, the module zip carries
// every file, and a customer's editor shows whichever comment they hover — so
// the rule the two checks above apply to `agent_sessions.go` and the AI error
// types is the rule for the whole package. This widens them to it.
//
// It reads real files and counts what it read: a walk that finds no files, or
// a parser that returns no comments, reports "clean" and is indistinguishable
// from a package with nothing wrong in it.
func TestEveryCommentInEveryShippedFileIsFreeOfInternalReferences(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		paths = append(paths, name)
	}
	examples, err := os.ReadDir("examples")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range examples {
		if e.IsDir() {
			paths = append(paths, "examples/"+e.Name()+"/main.go")
		}
	}
	sort.Strings(paths)

	// Floors, not targets. Measured on 2026-09-20: 28 non-test files at the
	// package root plus 12 example programs — 40 files carrying 716 comment
	// groups. A walk that stops finding them reports a clean package.
	if len(paths) < 38 {
		t.Fatalf("only %d shipped files found — the walk is not reading the package", len(paths))
	}
	groups := 0
	var hits []string
	for _, path := range paths {
		comments := fileComments(t, path)
		groups += len(comments)
		for line, text := range comments {
			hits = append(hits, internalFindings(path+":"+strconv.Itoa(line), text)...)
		}
	}
	if groups < 700 {
		t.Fatalf("only %d comment groups read across %d files", groups, len(paths))
	}
	if len(hits) > 0 {
		sort.Strings(hits)
		t.Errorf("internal references in customer-facing docs:\n%s", strings.Join(hits, "\n"))
	}
}

func TestTheAIExampleIsFreeOfInternalReferences(t *testing.T) {
	src, err := os.ReadFile("examples/agent_chat/main.go")
	if err != nil {
		t.Fatal(err)
	}
	var hits []string
	for i, line := range strings.Split(string(src), "\n") {
		hits = append(hits, internalFindings("agent_chat/main.go:"+strconv.Itoa(i+1), line)...)
	}
	if len(hits) > 0 {
		t.Errorf("internal references in the example:\n%s", strings.Join(hits, "\n"))
	}
}

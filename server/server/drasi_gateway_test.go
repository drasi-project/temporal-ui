package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	watchpb "github.com/drasi-project/temporal-drasi/contracts/watch/v1"
	"github.com/drasi-project/temporal-drasi/contracts/watch/validation"
	"github.com/stretchr/testify/require"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/temporalio/ui-server/v2/server/api"
	"github.com/temporalio/ui-server/v2/server/config"
	"github.com/temporalio/ui-server/v2/server/headers"
	"github.com/temporalio/ui-server/v2/server/server_options"
)

const (
	drasiNamespacePath = "/api/v1/namespaces/allowed/drasi"
	drasiDigest        = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	drasiQueryJSON     = `{"spec":{"language":"cypher","text":"MATCH (n) RETURN n","sources":[{"id":"source","revision":"1"}],"stateStore":"default"}}`
	drasiInstallJSON   = `{"catalogId":"trusted","pluginId":"postgres","version":"1.0.0","digest":"` + drasiDigest + `","requestId":"install"}`
)

type drasiGatewayConfig struct{ cfg *config.Config }

func (p drasiGatewayConfig) GetConfig() (*config.Config, error) { return p.cfg, nil }

type drasiGatewayCall struct {
	method  string
	request proto.Message
	headers metadata.MD
}

type drasiGatewayBackend struct {
	mu       sync.Mutex
	calls    []drasiGatewayCall
	response func(drasiGatewayCall) (proto.Message, error)
	outputs  map[string]protoreflect.MessageDescriptor
}

func (b *drasiGatewayBackend) snapshot() []drasiGatewayCall {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]drasiGatewayCall(nil), b.calls...)
}

func (b *drasiGatewayBackend) invoke(ctx context.Context, request any, info *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	call := drasiGatewayCall{info.FullMethod, proto.Clone(request.(proto.Message)), md.Copy()}
	b.mu.Lock()
	b.calls = append(b.calls, call)
	b.mu.Unlock()

	policy, ok := validation.Policy(info.FullMethod)
	if !ok {
		return next(ctx, request)
	}
	tokens := md.Get("authorization")
	if len(tokens) != 1 {
		return nil, status.Error(codes.Unauthenticated, "backend requires credentials")
	}
	role := strings.TrimPrefix(tokens[0], "Bearer ")
	if role != "reader" && role != "writer" && role != "admin" {
		return nil, status.Error(codes.Unauthenticated, "backend rejected credentials")
	}
	if namespace := validation.Namespace(request); namespace != "" && namespace != "allowed" {
		return nil, status.Error(codes.PermissionDenied, "namespace denied by backend")
	}
	if policy.Access == watchpb.Access_ACCESS_CLUSTER_ADMIN && role != "admin" ||
		policy.Access == watchpb.Access_ACCESS_NAMESPACE_WRITE && role == "reader" {
		return nil, status.Error(codes.PermissionDenied, "method denied by backend")
	}
	if b.response != nil {
		return b.response(call)
	}
	return dynamicpb.NewMessage(b.outputs[info.FullMethod]), nil
}

type drasiGatewayWorkflow struct {
	workflowservice.UnimplementedWorkflowServiceServer
}

func (*drasiGatewayWorkflow) GetSystemInfo(context.Context, *workflowservice.GetSystemInfoRequest) (*workflowservice.GetSystemInfoResponse, error) {
	return &workflowservice.GetSystemInfoResponse{}, nil
}

func newDrasiGatewayServer(t *testing.T, cfg *config.Config, response func(drasiGatewayCall) (proto.Message, error)) (*Server, *drasiGatewayBackend) {
	t.Helper()
	backend := &drasiGatewayBackend{response: response, outputs: make(map[string]protoreflect.MessageDescriptor)}
	services := watchpb.File_drasi_watch_v1_service_proto.Services()
	for i := 0; i < services.Len(); i++ {
		service := services.Get(i)
		for j := 0; j < service.Methods().Len(); j++ {
			method := service.Methods().Get(j)
			backend.outputs["/"+string(service.FullName())+"/"+string(method.Name())] = method.Output()
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	grpcServer := grpc.NewServer(grpc.UnaryInterceptor(backend.invoke))
	watchpb.RegisterWatchServiceServer(grpcServer, &watchpb.UnimplementedWatchServiceServer{})
	watchpb.RegisterPluginServiceServer(grpcServer, &watchpb.UnimplementedPluginServiceServer{})
	workflowservice.RegisterWorkflowServiceServer(grpcServer, &drasiGatewayWorkflow{})
	done := make(chan error, 1)
	go func() { done <- grpcServer.Serve(listener) }()
	t.Cleanup(func() {
		grpcServer.Stop()
		require.NoError(t, <-done)
	})
	cfg.TemporalGRPCAddress = listener.Addr().String()
	cfg.HideLogs = true
	server := NewServer(
		server_options.WithConfigProvider(drasiGatewayConfig{cfg}),
		server_options.WithAPIMiddleware([]api.Middleware{headers.WithForwardHeaders([]string{"X-Test-Tenant"})}),
	)
	t.Cleanup(func() {
		require.NoError(t, server.httpServer.Close())
		server.cfgProvider.Close()
	})
	return server, backend
}

func drasiGatewayRequest(server *Server, method, path, body, role string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if role != "" {
		request.Header.Set("Authorization", "Bearer "+role)
	}
	recorder := httptest.NewRecorder()
	server.httpServer.ServeHTTP(recorder, request)
	return recorder
}

func TestDrasiGatewayForwardsRequestCredentials(t *testing.T) {
	cfg := &config.Config{}
	server, backend := newDrasiGatewayServer(t, cfg, nil)
	cfg.Auth.Enabled = true
	for _, path := range []string{drasiNamespacePath + "/capabilities", "/api/v1/drasi/plugins/capabilities"} {
		for _, tenant := range []string{"tenant-one", "tenant-two"} {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.Header.Set("Authorization", "Bearer reader")
			request.Header.Set("Authorization-Extras", "id-token-"+tenant)
			request.Header.Set("Caller-Type", "temporal-ui")
			request.Header.Set("X-Test-Tenant", tenant)
			recorder := httptest.NewRecorder()
			server.httpServer.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			require.Contains(t, recorder.Header().Values("Vary"), "Authorization")
			calls := backend.snapshot()
			call := calls[len(calls)-1]
			require.Equal(t, []string{"Bearer reader"}, call.headers.Get("authorization"))
			require.Equal(t, []string{"Bearer reader"}, call.headers.Get("grpcgateway-authorization"))
			require.Equal(t, []string{"id-token-" + tenant}, call.headers.Get("authorization-extras"))
			require.Equal(t, []string{"temporal-ui"}, call.headers.Get("caller-type"))
			require.Equal(t, []string{tenant}, call.headers.Get("x-test-tenant"))
		}
	}
	require.Len(t, backend.snapshot(), 4)
}

func TestDrasiGatewayPreservesIDTokenForwardingConfiguration(t *testing.T) {
	cfg := &config.Config{}
	server, backend := newDrasiGatewayServer(t, cfg, nil)
	cfg.Auth = config.Auth{Enabled: true, Providers: []config.AuthProvider{{UseIDTokenAsBearer: true}}}
	request := httptest.NewRequest(http.MethodGet, drasiNamespacePath+"/capabilities", nil)
	request.Header.Set("Authorization", "Bearer access-token")
	request.Header.Set("Authorization-Extras", "reader")
	recorder := httptest.NewRecorder()
	server.httpServer.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	calls := backend.snapshot()
	require.Len(t, calls, 1)
	require.Equal(t, []string{"Bearer reader"}, calls[0].headers.Get("authorization"))
	require.Empty(t, calls[0].headers.Get("authorization-extras"))
}

func TestDrasiGatewayUsesBackendAuthorization(t *testing.T) {
	for _, authEnabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("UI authentication %t", authEnabled), func(t *testing.T) {
			cfg := &config.Config{}
			server, backend := newDrasiGatewayServer(t, cfg, nil)
			cfg.Auth.Enabled = authEnabled
			for _, test := range []struct {
				name, method, path, body, role string
				code                           int
			}{
				{"namespace read", "GET", drasiNamespacePath + "/sources", "", "reader", 200},
				{"invalid credentials", "GET", drasiNamespacePath + "/sources", "", "invalid", 401},
				{"different namespace", "GET", "/api/v1/namespaces/denied/drasi/capabilities", "", "reader", 403},
				{"namespace mutation", "POST", drasiNamespacePath + "/sources", `{"id":"source","requestId":"create","spec":{"temporal":{}}}`, "reader", 403},
				{"catalog read", "GET", "/api/v1/drasi/plugins", "", "reader", 200},
				{"install denied", "POST", "/api/v1/drasi/plugins/installations", drasiInstallJSON, "writer", 403},
				{"load denied", "POST", "/api/v1/drasi/plugins/installations/" + drasiDigest + "/load", `{"requestId":"load"}`, "writer", 403},
				{"install admin", "POST", "/api/v1/drasi/plugins/installations", drasiInstallJSON, "admin", 200},
			} {
				t.Run(test.name, func(t *testing.T) {
					before := len(backend.snapshot())
					response := drasiGatewayRequest(server, test.method, test.path, test.body, test.role)
					require.Equal(t, test.code, response.Code, response.Body.String())
					require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
					require.Len(t, backend.snapshot(), before+1)
				})
			}
			before := len(backend.snapshot())
			response := drasiGatewayRequest(server, http.MethodGet, drasiNamespacePath+"/sources", "", "")
			require.Equal(t, http.StatusUnauthorized, response.Code, response.Body.String())
			if authEnabled {
				require.Len(t, backend.snapshot(), before)
			} else {
				require.Len(t, backend.snapshot(), before+1)
			}
			request := httptest.NewRequest(http.MethodGet, drasiNamespacePath+"/sources", nil)
			request.Header.Set("Authorization", "Bearer invalid")
			request.Header.Set("Grpc-Metadata-Authorization", "Bearer admin")
			recorder := httptest.NewRecorder()
			server.httpServer.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
			for _, call := range backend.snapshot() {
				_, ok := validation.Policy(call.method)
				require.True(t, ok, "authorization must not probe WorkflowService: %s", call.method)
			}
		})
	}
}

func TestDrasiGatewayWritePolicyCoversEveryContractMethod(t *testing.T) {
	cfg := &config.Config{DisableWriteActions: true}
	server, backend := newDrasiGatewayServer(t, cfg, nil)
	services := watchpb.File_drasi_watch_v1_service_proto.Services()
	for i := 0; i < services.Len(); i++ {
		service := services.Get(i)
		for j := 0; j < service.Methods().Len(); j++ {
			method := service.Methods().Get(j)
			fullMethod := "/" + string(service.FullName()) + "/" + string(method.Name())
			t.Run(fullMethod, func(t *testing.T) {
				policy, ok := validation.Policy(fullMethod)
				require.True(t, ok)
				rule := proto.GetExtension(method.Options(), annotations.E_Http).(*annotations.HttpRule)
				httpMethod, path := http.MethodGet, rule.GetGet()
				switch {
				case rule.GetPost() != "":
					httpMethod, path = http.MethodPost, rule.GetPost()
				case rule.GetPut() != "":
					httpMethod, path = http.MethodPut, rule.GetPut()
				case rule.GetDelete() != "":
					httpMethod, path = http.MethodDelete, rule.GetDelete()
				}
				path = strings.NewReplacer(
					"{namespace}", "allowed", "{id}", "resource", "{action_id}", "action",
					"{catalog_id}", "trusted", "{plugin_id}", "postgres", "{version}", "1.0.0", "{digest}", drasiDigest,
				).Replace(path)
				body := drasiQueryJSON
				if method.Name() == "PreviewQuery" {
					body = strings.TrimSuffix(body, "}") + `,"limit":1}`
				}
				before := len(backend.snapshot())
				response := drasiGatewayRequest(server, httpMethod, path, body, "admin")
				if policy.Mutation {
					require.Equal(t, http.StatusMethodNotAllowed, response.Code, response.Body.String())
					require.Len(t, backend.snapshot(), before)
				} else {
					require.Equal(t, http.StatusOK, response.Code, response.Body.String())
					calls := backend.snapshot()
					require.Len(t, calls, before+1)
					require.Equal(t, fullMethod, calls[len(calls)-1].method)
				}
				require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			})
		}
	}
	cfg.DisableWriteActions = false
	response := drasiGatewayRequest(server, http.MethodPost, "/api/v1/drasi/plugins/installations", drasiInstallJSON, "admin")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
}

func TestDrasiGatewayBasePathAndCSRF(t *testing.T) {
	server, backend := newDrasiGatewayServer(t, &config.Config{PublicPath: "/temporal", DisableWriteActions: true}, nil)
	request := httptest.NewRequest(http.MethodPost, "/temporal"+drasiNamespacePath+"/queries/validate", strings.NewReader(drasiQueryJSON))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.httpServer.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	require.Empty(t, backend.snapshot())

	request = httptest.NewRequest(http.MethodPost, "/temporal"+drasiNamespacePath+"/queries/validate", strings.NewReader(drasiQueryJSON))
	request.Header.Set("Content-Type", "application/json")
	for _, cookie := range recorder.Result().Cookies() {
		request.AddCookie(cookie)
		if cookie.Name == "_csrf" {
			request.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	recorder = httptest.NewRecorder()
	server.httpServer.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
	calls := backend.snapshot()
	require.Len(t, calls, 1)
	require.Equal(t, watchpb.WatchService_ValidateQuery_FullMethodName, calls[0].method)
	require.Equal(t, "allowed", validation.Namespace(calls[0].request))

	for _, path := range []string{drasiNamespacePath + "/capabilities", "/api/v1/drasi/plugins/capabilities", "/api/v1/system-info"} {
		response := drasiGatewayRequest(server, http.MethodGet, "/temporal"+path, "", "reader")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/temporal"+drasiNamespacePath+"/queries/validate", strings.NewReader(drasiQueryJSON))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Authorization", "Bearer reader")
	request.Header.Set("X-HTTP-Method-Override", http.MethodDelete)
	recorder = httptest.NewRecorder()
	server.httpServer.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	calls = backend.snapshot()
	require.Equal(t, watchpb.WatchService_ValidateQuery_FullMethodName, calls[len(calls)-1].method)
}

func TestDrasiGatewayResourceIDsCanMatchOperationNames(t *testing.T) {
	server, backend := newDrasiGatewayServer(t, &config.Config{}, nil)
	for _, id := range []string{"validate", "preview"} {
		response := drasiGatewayRequest(server, http.MethodGet, drasiNamespacePath+"/queries/"+id, "", "reader")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		calls := backend.snapshot()
		call := calls[len(calls)-1]
		require.Equal(t, watchpb.WatchService_GetQuery_FullMethodName, call.method)
		require.Equal(t, id, call.request.(*watchpb.GetQueryRequest).Id)
	}
}

func TestDrasiGatewayPreservesGRPCErrorDetails(t *testing.T) {
	for _, code := range []codes.Code{codes.Unauthenticated, codes.PermissionDenied, codes.InvalidArgument, codes.NotFound, codes.Aborted, codes.Unavailable, codes.Unimplemented} {
		t.Run(code.String(), func(t *testing.T) {
			grpcError, err := status.New(code, "backend diagnostic").WithDetails(&errdetails.ResourceInfo{
				ResourceType: "drasi.query", ResourceName: "missing",
			})
			require.NoError(t, err)
			server, backend := newDrasiGatewayServer(t, &config.Config{}, func(drasiGatewayCall) (proto.Message, error) {
				return nil, grpcError.Err()
			})
			response := drasiGatewayRequest(server, http.MethodGet, drasiNamespacePath+"/queries", "", "reader")
			expected := map[codes.Code]int{
				codes.Unauthenticated: 401, codes.PermissionDenied: 403, codes.InvalidArgument: 400,
				codes.NotFound: 404, codes.Aborted: 409, codes.Unavailable: 503, codes.Unimplemented: 501,
			}
			require.Equal(t, expected[code], response.Code, response.Body.String())
			var body map[string]any
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, float64(code), body["code"])
			require.Equal(t, "backend diagnostic", body["message"])
			details := body["details"].([]any)[0].(map[string]any)
			require.Equal(t, "type.googleapis.com/google.rpc.ResourceInfo", details["@type"])
			require.Equal(t, "drasi.query", details["resourceType"])
			require.Len(t, backend.snapshot(), 1)
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
		})
	}
}

func TestDrasiGatewayBoundsAndValidatesRequests(t *testing.T) {
	server, backend := newDrasiGatewayServer(t, &config.Config{}, nil)
	for _, test := range []struct {
		name, method, path, body string
	}{
		{"page size", "GET", drasiNamespacePath + "/sources?pageSize=201", ""},
		{"page token", "GET", drasiNamespacePath + "/sources?pageToken=" + strings.Repeat("x", 4097), ""},
		{"preview limit", "POST", drasiNamespacePath + "/queries/preview", strings.TrimSuffix(drasiQueryJSON, "}") + `,"limit":201}`},
		{"query size", "POST", drasiNamespacePath + "/queries/validate", strings.Replace(drasiQueryJSON, "MATCH (n) RETURN n", strings.Repeat("x", 65537), 1)},
		{"source oneof", "POST", drasiNamespacePath + "/sources", `{"id":"source","requestId":"create","spec":{"temporal":{},"external":{}}}`},
		{"TypeScript union is not wire JSON", "POST", drasiNamespacePath + "/sources", `{"id":"source","requestId":"create","spec":{"kind":{"$case":"temporal","value":{}}}}`},
		{"action oneof", "POST", drasiNamespacePath + "/watches", `{"id":"watch","requestId":"create","spec":{"action":{"start":{},"signal":{}}}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := drasiGatewayRequest(server, test.method, test.path, test.body, "admin")
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Empty(t, backend.snapshot())
		})
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, lengthKnown := range []bool{true, false} {
			t.Run(fmt.Sprintf("HTTP body %s length-known=%t", method, lengthKnown), func(t *testing.T) {
				path := drasiNamespacePath + "/queries/validate"
				if method == http.MethodGet {
					path = drasiNamespacePath + "/capabilities"
				}
				request := httptest.NewRequest(method, path, strings.NewReader(drasiQueryJSON+strings.Repeat(" ", validation.MaxRequestBytes)))
				request.Header.Set("Authorization", "Bearer admin")
				request.Header.Set("Content-Type", "application/json")
				if !lengthKnown {
					request.ContentLength = -1
				}
				recorder := httptest.NewRecorder()
				server.httpServer.ServeHTTP(recorder, request)
				require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code, recorder.Body.String())
				require.Empty(t, backend.snapshot())
			})
		}
	}

	fields := make(map[string]*structpb.Value, 60000)
	for i := 0; i < 60000; i++ {
		fields[fmt.Sprintf("field%d", i)] = structpb.NewNumberValue(0)
	}
	request := &watchpb.CreateSourceRequest{
		Namespace: "allowed", Id: "large", RequestId: "create",
		Spec: &watchpb.SourceSpec{Kind: &watchpb.SourceSpec_External{External: &watchpb.ComponentConfiguration{
			Plugin:        &watchpb.PluginComponentRef{Digest: drasiDigest, Component: "source"},
			Configuration: &structpb.Struct{Fields: fields},
		}}},
	}
	body, err := protojson.Marshal(request)
	require.NoError(t, err)
	require.LessOrEqual(t, len(body), validation.MaxRequestBytes)
	require.Greater(t, proto.Size(request), validation.MaxRequestBytes)
	response := drasiGatewayRequest(server, http.MethodPost, drasiNamespacePath+"/sources", string(body), "admin")
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "maximum encoded size")
	require.Empty(t, backend.snapshot())
}

func TestDrasiGatewayUsesStandardProtobufWireJSON(t *testing.T) {
	server, backend := newDrasiGatewayServer(t, &config.Config{}, func(call drasiGatewayCall) (proto.Message, error) {
		switch request := call.request.(type) {
		case *watchpb.CreateSourceRequest:
			return &watchpb.Source{
				Namespace: request.Namespace, Id: request.Id, Revision: 9007199254740993, Spec: request.Spec,
				DesiredState: watchpb.DesiredState_DESIRED_STATE_STOPPED,
			}, nil
		case *watchpb.CreateWatchRequest:
			return &watchpb.Watch{
				Namespace: request.Namespace, Id: request.Id, Revision: 9007199254740993, Spec: request.Spec,
				DesiredState: watchpb.DesiredState_DESIRED_STATE_RUNNING,
			}, nil
		default:
			return nil, status.Error(codes.Unimplemented, "unexpected test method")
		}
	})
	for _, spec := range []string{
		`{"temporal":{}}`,
		`{"external":{"plugin":{"digest":"` + drasiDigest + `","component":"postgres"},"configuration":{"table":"events"},"secrets":{"password":{"provider":"vault","key":"db","version":"v1"}}},"bootstrap":{"plugin":{"digest":"` + drasiDigest + `","component":"snapshot"}}}`,
	} {
		body := `{"namespace":"body-must-not-override-path","id":"source","requestId":"create","spec":` + spec + `}`
		response := drasiGatewayRequest(server, http.MethodPost, drasiNamespacePath+"/sources", body, "writer")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var actual watchpb.Source
		require.NoError(t, protojson.Unmarshal(response.Body.Bytes(), &actual))
		calls := backend.snapshot()
		request := calls[len(calls)-1].request.(*watchpb.CreateSourceRequest)
		require.Equal(t, "allowed", request.Namespace)
		require.True(t, proto.Equal(request.Spec, actual.Spec))
		require.Contains(t, response.Body.String(), `"revision":"9007199254740993"`)
		require.Contains(t, response.Body.String(), `"desiredState":"DESIRED_STATE_STOPPED"`)
	}

	for _, test := range []struct{ lifetime, action string }{
		{`"persistent":{}`, `"start":{"workflowId":"effect-{action_id}","workflowType":"Effect","taskQueue":"effects","input":{"payloads":[{"metadata":{"encoding":"anNvbi9wbGFpbg=="},"data":"eyJvayI6dHJ1ZX0="}]},"runTimeout":"30s"}`},
		{`"persistent":{}`, `"signal":{"currentWorkflowId":"current","signalName":"changed"}`},
		{`"persistent":{}`, `"signalWithStart":{"start":{"workflowId":"effect","workflowType":"Effect","taskQueue":"effects"},"signalName":"changed"}`},
		{`"once":{"owner":{"workflowId":"owner","runId":"run"},"deadline":"2030-01-01T00:00:00Z"}`, `"signal":{"run":{"workflowId":"owner","runId":"run"},"signalName":"changed"}`},
	} {
		body := `{"id":"watch","requestId":"create","spec":{"query":{"id":"query","revision":"9007199254740993"},"trigger":"TRIGGER_ENTER",` + test.lifetime + `,"action":{` + test.action + `}}}`
		response := drasiGatewayRequest(server, http.MethodPost, drasiNamespacePath+"/watches", body, "writer")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var actual watchpb.Watch
		require.NoError(t, protojson.Unmarshal(response.Body.Bytes(), &actual))
		calls := backend.snapshot()
		request := calls[len(calls)-1].request.(*watchpb.CreateWatchRequest)
		require.True(t, proto.Equal(request.Spec, actual.Spec))
		require.Contains(t, response.Body.String(), `"trigger":"TRIGGER_ENTER"`)
		require.Contains(t, response.Body.String(), `"desiredState":"DESIRED_STATE_RUNNING"`)
		require.Contains(t, response.Body.String(), `"revision":"9007199254740993"`)
		require.NotContains(t, response.Body.String(), `"$case"`)
		if start := request.Spec.Action.GetStart(); start != nil {
			require.Equal(t, "json/plain", string(start.Input.Payloads[0].Metadata["encoding"]))
			require.Equal(t, `{"ok":true}`, string(start.Input.Payloads[0].Data))
		}
	}
}

func TestNewServerSurfacesAPIRouteErrors(t *testing.T) {
	require.PanicsWithError(t, "Failed to create gRPC connection to Temporal server: Unable to read TLS configs: cannot specify TLS CA file and CA data at the same time", func() {
		NewServer(server_options.WithConfigProvider(drasiGatewayConfig{&config.Config{
			HideLogs: true, TLS: config.TLS{CaFile: "ca.pem", CaData: "conflicting-ca"},
		}}))
	})
}

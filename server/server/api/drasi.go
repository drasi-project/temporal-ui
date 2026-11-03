package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	watchpb "github.com/drasi-project/temporal-drasi/contracts/watch/v1"
	"github.com/drasi-project/temporal-drasi/contracts/watch/validation"
	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"github.com/labstack/echo/v4"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	"github.com/temporalio/ui-server/v2/server/auth"
	"github.com/temporalio/ui-server/v2/server/config"
	"github.com/temporalio/ui-server/v2/server/version"
)

type drasiRoute struct {
	method string
	path   string
	policy validation.MethodPolicy
}

var drasiPathParameter = regexp.MustCompile(`\{([a-zA-Z_][a-zA-Z0-9_]*)\}`)

func RegisterDrasiRoutes(e *echo.Echo, cfgProvider *config.ConfigProviderWithRefresh, apiMiddleware []Middleware, conn *grpc.ClientConn) error {
	routes, err := drasiRoutes()
	if err != nil {
		return err
	}
	if _, err := newDrasiMux(conn, nil); err != nil {
		return err
	}

	for _, route := range routes {
		e.Add(route.method, route.path, func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-store")
			c.Response().Header().Add("Vary", echo.HeaderAuthorization)

			if err := auth.ValidateAuthHeaderExists(c, cfgProvider); err != nil {
				return err
			}
			cfg, err := cfgProvider.GetConfig()
			if err != nil {
				return err
			}
			if cfg.DisableWriteActions && route.policy.Mutation {
				return echo.ErrMethodNotAllowed
			}
			request := c.Request()
			if request.Body != nil {
				defer request.Body.Close()
				body, err := io.ReadAll(http.MaxBytesReader(c.Response(), request.Body, validation.MaxRequestBytes))
				if err != nil {
					var sizeError *http.MaxBytesError
					if errors.As(err, &sizeError) {
						return echo.ErrStatusRequestEntityTooLarge
					}
					return echo.NewHTTPError(http.StatusBadRequest, "unable to read request body").SetInternal(err)
				}
				request.Body = io.NopCloser(bytes.NewReader(body))
			}

			opts := []runtime.ServeMuxOption{version.WithVersionHeader(c)}
			for _, m := range apiMiddleware {
				opts = append(opts, m(c))
			}
			mux, err := newDrasiMux(conn, opts)
			if err != nil {
				return err
			}
			mux.ServeHTTP(c.Response(), request)
			return nil
		})
	}
	return nil
}

func newDrasiMux(conn *grpc.ClientConn, opts []runtime.ServeMuxOption) (*runtime.ServeMux, error) {
	mux := runtime.NewServeMux(append(opts,
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{}),
		runtime.WithUnescapingMode(runtime.UnescapingModeAllExceptReserved),
		runtime.WithDisableHTTPMethodOverride(),
	)...)
	if err := watchpb.RegisterWatchServiceHandler(context.Background(), mux, conn); err != nil {
		return nil, fmt.Errorf("register WatchService gateway: %w", err)
	}
	if err := watchpb.RegisterPluginServiceHandler(context.Background(), mux, conn); err != nil {
		return nil, fmt.Errorf("register PluginService gateway: %w", err)
	}
	return mux, nil
}

func drasiRoutes() ([]drasiRoute, error) {
	var routes []drasiRoute
	services := watchpb.File_drasi_watch_v1_service_proto.Services()
	for i := 0; i < services.Len(); i++ {
		service := services.Get(i)
		methods := service.Methods()
		for j := 0; j < methods.Len(); j++ {
			method := methods.Get(j)
			fullMethod := "/" + string(service.FullName()) + "/" + string(method.Name())
			policy, ok := validation.Policy(fullMethod)
			if !ok {
				return nil, fmt.Errorf("missing Drasi method policy: %s", fullMethod)
			}
			rule, ok := proto.GetExtension(method.Options(), annotations.E_Http).(*annotations.HttpRule)
			if !ok || rule == nil {
				return nil, fmt.Errorf("missing Drasi HTTP annotation: %s", fullMethod)
			}
			for _, binding := range append([]*annotations.HttpRule{rule}, rule.AdditionalBindings...) {
				route, err := drasiHTTPRoute(binding, policy)
				if err != nil {
					return nil, fmt.Errorf("%s: %w", fullMethod, err)
				}
				routes = append(routes, route)
			}
		}
	}
	return routes, nil
}

func drasiHTTPRoute(rule *annotations.HttpRule, policy validation.MethodPolicy) (drasiRoute, error) {
	var method, path string
	switch pattern := rule.Pattern.(type) {
	case *annotations.HttpRule_Get:
		method, path = http.MethodGet, pattern.Get
	case *annotations.HttpRule_Post:
		method, path = http.MethodPost, pattern.Post
	case *annotations.HttpRule_Put:
		method, path = http.MethodPut, pattern.Put
	case *annotations.HttpRule_Patch:
		method, path = http.MethodPatch, pattern.Patch
	case *annotations.HttpRule_Delete:
		method, path = http.MethodDelete, pattern.Delete
	default:
		return drasiRoute{}, fmt.Errorf("unsupported Drasi HTTP binding: %v", rule.Pattern)
	}
	path = drasiPathParameter.ReplaceAllString(path, ":$1")
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "{}*=") {
		return drasiRoute{}, fmt.Errorf("unsupported Drasi HTTP path: %s", path)
	}
	return drasiRoute{method: method, path: path, policy: policy}, nil
}

func validateDrasiRequest(ctx context.Context, method string, request, response any, conn *grpc.ClientConn, invoke grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	if _, ok := validation.Policy(method); ok {
		message, ok := request.(proto.Message)
		if !ok {
			return status.Error(codes.InvalidArgument, "Drasi request must be a protobuf message")
		}
		if err := validation.ValidateRequest(message); err != nil {
			return err
		}
		opts = append(opts, grpc.MaxCallSendMsgSize(validation.MaxRequestBytes))
	}
	return invoke(ctx, method, request, response, conn, opts...)
}

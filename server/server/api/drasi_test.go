package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/drasi-project/temporal-drasi/contracts/watch/validation"
	"github.com/stretchr/testify/require"
	commonpb "go.temporal.io/api/common/v1"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/grpc"
)

func TestDrasiHTTPRouteUsesContractBindings(t *testing.T) {
	policy := validation.MethodPolicy{Mutation: true}
	route, err := drasiHTTPRoute(&annotations.HttpRule{
		Pattern: &annotations.HttpRule_Post{Post: "/api/v1/namespaces/{namespace}/drasi/sources/{id}/start"},
	}, policy)
	require.NoError(t, err)
	require.Equal(t, drasiRoute{
		method: http.MethodPost, path: "/api/v1/namespaces/:namespace/drasi/sources/:id/start", policy: policy,
	}, route)
	for _, rule := range []*annotations.HttpRule{
		{},
		{Pattern: &annotations.HttpRule_Get{Get: ""}},
		{Pattern: &annotations.HttpRule_Get{Get: "/api/v1/{name=namespaces/*}/drasi"}},
		{Pattern: &annotations.HttpRule_Get{Get: "/api/v1/{nested.name}/drasi"}},
	} {
		_, err := drasiHTTPRoute(rule, policy)
		require.Error(t, err)
	}

}

func TestDrasiRequestLimitsLeaveWorkflowServiceUnchanged(t *testing.T) {
	request := &workflowservice.StartWorkflowExecutionRequest{
		Input: &commonpb.Payloads{Payloads: []*commonpb.Payload{{Data: make([]byte, validation.MaxRequestBytes+1)}}},
	}
	invoked := false
	err := validateDrasiRequest(context.Background(),
		"/temporal.api.workflowservice.v1.WorkflowService/StartWorkflowExecution", request, nil, nil,
		func(_ context.Context, _ string, actual, _ any, _ *grpc.ClientConn, opts ...grpc.CallOption) error {
			invoked = true
			require.Same(t, request, actual)
			require.Empty(t, opts)
			return nil
		})
	require.NoError(t, err)
	require.True(t, invoked)
}

package main; import ("fmt"; "github.com/ethereum/go-ethereum/signer/core/apitypes"); func main() { var d apitypes.TypedData; h, _, _ := apitypes.TypedDataAndHash(d); fmt.Println(len(h)) }
